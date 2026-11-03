// Bale connectivity probe, for the owner's /diag command and CI
// (`npx tgcloud run handlers/message '{ __diag: true }'`).
// Reports per-attempt outcome and timing only: no tokens, ids or contents.

import { api, db } from 'sdk';
import { sql } from 'sdk/db';
import { baleCall, baleCallOnce, safeErrorText } from './bale.js';
import { OWNER_TELEGRAM_ID } from './config.js';
import { getUser } from './store.js';
import { getSetting } from './eitaa.js';
import { rowsOf } from './util.js';
import { enqueuePost, enqueueEdit, drain } from './mirror.js';
import { saveChannel } from './channels.js';

const BUDGET_MS = 22000;

function summarize(r, ms) {
  const out = { ok: r.ok === true, ms, via: r.via };
  if (!r.ok) {
    out.code = r.error_code;
    if (r.network) out.network = true;
    out.desc = safeErrorText({ name: 'E', description: r.detail || r.description }).replace(/^E: /, '').slice(0, 160);
  }
  return out;
}

async function attempt(method, params) {
  const t = Date.now();
  let r;
  try {
    r = await baleCallOnce(method, params);
  } catch (e) {
    r = { ok: false, error_code: -1, description: safeErrorText(e) };
  }
  return summarize(r, Date.now() - t);
}

export async function runBaleProbe(baleChatId, text) {
  const started = Date.now();
  const report = { chatIdType: baleChatId === null || baleChatId === undefined ? 'none' : typeof baleChatId, getMe: [], sendMessage: [] };
  const left = () => BUDGET_MS - (Date.now() - started);
  for (let i = 0; i < 2 && left() > 6000; i++) report.getMe.push(await attempt('getMe', {}));
  if (baleChatId) {
    for (let i = 0; i < 3 && left() > 6000; i++) {
      const r = await attempt('sendMessage', { chat_id: baleChatId, text });
      report.sendMessage.push(r);
      if (r.ok) break;
    }
  }
  report.totalMs = Date.now() - started;
  return report;
}

export async function runDiag() {
  const owner = await getUser(OWNER_TELEGRAM_ID);
  return runBaleProbe(owner && owner.baleChatId, '🔧 آزمایش اتصال (از طرف مدیر ربات)');
}

export function formatProbe(report) {
  const line = (r) => `${r.via === 'relay' ? '☁️ رله' : '↔️ مستقیم'} ` + (r.ok ? `✅ ${r.ms}ms` : `❌ ${r.ms}ms code=${r.code}${r.network ? ' network' : ''} ${r.desc || ''}`);
  return [
    '🔧 بررسی اتصال به بله',
    `chat id: ${report.chatIdType}`,
    'getMe:', ...report.getMe.map(line),
    'sendMessage:', ...(report.sendMessage.length ? report.sendMessage.map(line) : ['—']),
    `total: ${report.totalMs}ms`,
  ].join('\n');
}

// End-to-end check of the mirror queue (post → edit → delete) with a fake
// channel (-42) whose Bale target is the owner's own Bale chat.
export async function runMirrorTest() {
  const owner = await getUser(OWNER_TELEGRAM_ID);
  if (!owner || !owner.baleChatId) return { ok: false, error: 'owner not linked' };
  const ch = -42;
  const out = {};
  try {
    await saveChannel(ch, owner.baleChatId, OWNER_TELEGRAM_ID);
    const mid = Math.floor(Date.now() / 1000);
    await enqueuePost(ch, { message_id: mid, chat: { id: ch, type: 'channel' }, text: '🔧 آزمایش صف: پست', entities: [{ type: 'bold', offset: 3, length: 6 }] });
    out.post = (await drain(ch, { deadline: Date.now() + 8000 })).status;
    const m1 = await db.get(sql`SELECT bale_ids, layout FROM mirrored WHERE tg_chat_id = ${ch} AND tg_message_id = ${mid}`);
    out.mirrored = m1 && { ids: JSON.parse(m1.bale_ids).length, layout: m1.layout };
    await enqueueEdit(ch, { message_id: mid, chat: { id: ch, type: 'channel' }, text: '🔧 آزمایش صف: پست ویرایش‌شده' });
    out.edit = (await drain(ch, { deadline: Date.now() + 8000 })).status;
    await db.run(sql`INSERT INTO outbox (tg_channel_id, sort_key, kind, created_at) VALUES (${ch}, ${mid}, 'delete', ${mid})`);
    out.delete = (await drain(ch, { deadline: Date.now() + 8000 })).status;
    const m2 = await db.get(sql`SELECT 1 AS x FROM mirrored WHERE tg_chat_id = ${ch} AND tg_message_id = ${mid}`);
    out.mirroredAfterDelete = Boolean(m2);
    const left = await db.get(sql`SELECT count(*) AS n FROM outbox WHERE tg_channel_id = ${ch}`);
    out.jobsLeft = left.n;
  } finally {
    await db.run(sql`DELETE FROM outbox WHERE tg_channel_id = ${ch}`);
    await db.run(sql`DELETE FROM mirrored WHERE tg_chat_id = ${ch}`);
    await db.run(sql`DELETE FROM channels WHERE tg_channel_id = ${ch}`);
  }
  out.ok = out.post === 'empty' && out.edit === 'empty' && out.delete === 'empty' && !out.mirroredAfterDelete && out.jobsLeft === 0;
  return out;
}

// CI probe (__bale_state): the Bale channel mirror's state as counts and
// ages (seconds) only — no ids or contents (CI logs are public). For the
// newest mirrored posts it also asks Telegram whether they still exist.
export async function runBaleState() {
  const t = Math.floor(Date.now() / 1000);
  const channels = await db.all(sql`SELECT tg_channel_id, bale_chat_id, lock_until, probed_at, delivered_count, failed_count FROM channels`);
  const out = { channels: [] };
  for (const ch of channels) {
    const id = ch.tg_channel_id;
    const m = await db.get(sql`
      SELECT count(*) AS n, sum(CASE WHEN created_at > ${t - 47 * 3600} THEN 1 ELSE 0 END) AS recent,
             max(created_at) AS newest, min(checked_at) AS oldest_check, max(checked_at) AS newest_check
      FROM mirrored WHERE tg_chat_id = ${id}`);
    const jobs = await db.all(sql`SELECT kind, attempts, last_reason, created_at FROM outbox WHERE tg_channel_id = ${id}`);
    const last = await db.all(sql`
      SELECT tg_message_id, created_at, checked_at FROM mirrored WHERE tg_chat_id = ${id} ORDER BY tg_message_id DESC LIMIT 3`);
    const probes = [];
    for (const r of last) {
      let answer;
      try {
        await api.editMessageReplyMarkup({ chat_id: id, message_id: r.tg_message_id });
        answer = 'ok';
      } catch (e) {
        answer = `${e.code} ${String(e.description).slice(0, 60)}`;
      }
      probes.push({ ageS: t - r.created_at, checkedAgoS: r.checked_at ? t - r.checked_at : null, telegram: answer });
    }
    const tracked = await db.get(sql`SELECT count(*) AS n, max(message_id) AS top FROM delivered WHERE chat_id = ${id}`);
    // The Bale bot's rights in the Bale chat (read only).
    let baleRights = null;
    const me = await baleCall('getMe', {});
    const admins = await baleCall('getChatAdministrators', { chat_id: ch.bale_chat_id });
    if (admins.ok && me.ok) {
      const bot = (admins.result || []).find((a) => a.user && a.user.id === me.result.id);
      baleRights = bot ? Object.fromEntries(Object.entries(bot).filter(([k]) => k.startsWith('can_') || k === 'status')) : 'not admin';
    } else {
      baleRights = { error: admins.error_code || me.error_code, via: admins.via };
    }
    out.channels.push({
      baleRights,
      lockHeld: ch.lock_until > t, probedAgoS: ch.probed_at ? t - ch.probed_at : null,
      delivered: ch.delivered_count, failed: ch.failed_count,
      mirrored: { total: m.n, last47h: m.recent || 0, newestAgoS: m.newest ? t - m.newest : null },
      jobs: jobs.map((j) => ({ kind: j.kind, attempts: j.attempts, reason: j.last_reason, ageS: t - j.created_at })),
      newestPosts: probes,
      seenPosts: tracked.n,
      newestSeenAboveMirrored: Boolean(tracked.top && last[0] && tracked.top > last[0].tg_message_id),
    });
  }
  // Without ids here: CI logs are public (the owner sees them with /bale_diag deletes).
  out.lastDeletes = (await getSetting('bale_deletes', [])).map(({ tg, bale, ...rest }) => rest);
  // Which diagnostic tables/columns exist (did the migration apply?).
  out.schema = {};
  for (const tbl of ['bale_calls', 'debug_events']) {
    const cols = await db.all(sql`SELECT name FROM pragma_table_info(${tbl})`).catch(() => []);
    out.schema[tbl] = cols.map((c) => c.name).join(',') || 'missing';
  }
  // Bale attempts per method in the last 30 minutes, and how many calls
  // (a call = one baleCall with its retries) there were.
  out.calls30m = await db.all(sql`
    SELECT method, count(*) AS attempts, count(DISTINCT call_id) AS calls,
           sum(CASE WHEN ok = 1 THEN 1 ELSE 0 END) AS ok, min(at_ms) AS first_ms, max(at_ms) AS last_ms
    FROM bale_calls WHERE at_ms > ${Date.now() - 30 * 60 * 1000} GROUP BY method`);
  // Channel posts the bot recorded (claimed) in the last 30 minutes.
  out.claimed30m = (await db.get(sql`
    SELECT count(*) AS n FROM delivered WHERE chat_id < 0 AND created_at > ${t - 30 * 60}`)).n;
  // The last Bale calls as [seconds ago, method, via, ok, network, code, ms]
  // (no ids), and leftover album state: to follow one album's path.
  out.recent = rowsOf(await db.all(sql`
    SELECT at_ms, method, via, ok, network, code, ms FROM bale_calls
    WHERE at_ms > ${Date.now() - 60 * 60 * 1000} AND method != 'getUpdates' ORDER BY id DESC LIMIT 40`))
    .map((c) => [Math.round((Date.now() - c.at_ms) / 1000), c.method, c.via, c.ok ? 1 : 0, c.network ? 1 : 0, c.code || 0, c.ms]);
  out.albumState = await db.get(sql`
    SELECT (SELECT count(*) FROM album_items WHERE chat_id < 0) AS items,
           (SELECT count(*) FROM album_items WHERE chat_id < 0 AND taken = 1) AS taken,
           (SELECT count(*) FROM albums WHERE key LIKE '-%' AND created_ms > ${Date.now() - 3600 * 1000}) AS albums1h`);
  out.mirrored1h = rowsOf(await db.all(sql`
    SELECT layout, count(*) AS n FROM mirrored WHERE created_at > ${t - 3600} GROUP BY layout`));
  out.errors = (await getSetting('errors', [])).slice(0, 6).map((e) => [t - e.at, e.where, e.name, String(e.msg).slice(0, 60)]);
  out.now = t;
  return out;
}

// Owner only (/bale_diag deletes): the last Bale delete answers with the
// Telegram and Bale message ids, in Tehran time.
export async function formatDeleteLog() {
  const list = await getSetting('bale_deletes', []);
  if (!list.length) return 'هنوز حذفی در بله انجام نشده است.';
  const time = (t) => new Date((t + 3.5 * 3600) * 1000).toISOString().slice(11, 19);
  return ['🗑 آخرین درخواست‌های حذف در بله (ساعت تهران):', ...list.map((d) =>
    `${time(d.at)} · ${d.why || '?'} · تلگرام ${d.tg ?? '?'} → بله ${d.bale ?? '?'} · ${d.ok ? (d.result === false ? 'ok اما false' : 'انجام شد') : `خطا ${d.code} ${d.desc || ''}`} · ${d.via || ''}`)].join('\n');
}

// Owner only (/bale_diag calls): the last Bale send/edit/delete attempts,
// grouped per call, in Tehran time. A call whose first attempt timed out
// (network, ~5 s) and whose retry succeeded may have arrived twice.
export async function formatCallLog() {
  const rows = await db.all(sql`SELECT * FROM bale_calls ORDER BY id DESC LIMIT 60`);
  if (!rows.length) return 'هنوز تلاشی ثبت نشده است.';
  const calls = new Map();
  for (const r of rows.reverse()) {
    if (!calls.has(r.call_id)) calls.set(r.call_id, []);
    calls.get(r.call_id).push(r);
  }
  const time = (ms) => new Date(ms + 3.5 * 3600 * 1000).toISOString().slice(11, 19);
  const lines = ['📮 آخرین تلاش‌های ارسال/حذف در بله (ساعت تهران):'];
  let suspects = 0;
  for (const list of [...calls.values()].slice(-30)) {
    const steps = list.map((a) => `${a.via === 'relay' ? '☁️' : '↔️'}${a.ok ? '✅' : '❌'}${a.ms}ms${a.network ? '' : a.ok ? '' : ' ' + a.code}`);
    const risky = list.length > 1 && list.some((a) => !a.ok && a.network && a.ms >= 4500) && list[list.length - 1].ok;
    if (risky) suspects++;
    lines.push(`${time(list[0].at_ms)} ${list[0].method} ${steps.join(' → ')}${risky ? ' ⚠️ شاید دوبار' : ''}`);
  }
  lines.push('', `مشکوک به ارسال دوباره: ${suspects}`);
  return lines.join('\n');
}

// Burst test (CI: __burst_prepare, many parallel channel_post runs for the
// fake channel -42, then __burst_report). The fake channel mirrors into the
// owner's own Bale chat; the report deletes every test message it sent.
const BURST_CHANNEL = -42;

export async function runBurstPrepare() {
  const owner = await getUser(OWNER_TELEGRAM_ID);
  if (!owner || !owner.baleChatId) return { ok: false, error: 'owner not linked' };
  await cleanupBurst(owner.baleChatId);
  await db.run(sql`DELETE FROM debug_events`);
  await saveChannel(BURST_CHANNEL, owner.baleChatId, OWNER_TELEGRAM_ID);
  // Bale calls are counted from this row on (a time window also caught the
  // previous test's messages).
  const last = await db.get(sql`SELECT max(id) AS id FROM bale_calls`);
  const st = { atMs: Date.now(), fromCallId: Number(last && last.id) || 0 };
  await db.run(sql`
    INSERT INTO eitaa_settings (key, value, updated_at) VALUES ('burst', ${JSON.stringify(st)}, ${Math.floor(Date.now() / 1000)})
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`);
  return { ok: true };
}

async function cleanupBurst(baleChatId, fromCallId) {
  let deleted = 0;
  if (fromCallId !== undefined) {
    const sent = await db.all(sql`
      SELECT DISTINCT result_id FROM bale_calls
      WHERE method = 'sendMessage' AND ok = 1 AND chat_id = ${baleChatId} AND id > ${fromCallId} AND result_id IS NOT NULL`);
    for (const r of sent) {
      const d = await baleCall('deleteMessage', { chat_id: baleChatId, message_id: r.result_id });
      if (d.ok) deleted++;
    }
  }
  await db.run(sql`DELETE FROM outbox WHERE tg_channel_id = ${BURST_CHANNEL}`);
  await db.run(sql`DELETE FROM mirrored WHERE tg_chat_id = ${BURST_CHANNEL}`);
  await db.run(sql`DELETE FROM delivered WHERE chat_id = ${BURST_CHANNEL}`);
  await db.run(sql`DELETE FROM channels WHERE tg_channel_id = ${BURST_CHANNEL}`);
  return deleted;
}

export async function runBurstReport() {
  const owner = await getUser(OWNER_TELEGRAM_ID);
  const st = await getSetting('burst', null);
  if (!owner || !st) return { ok: false, error: 'not prepared' };
  const claimed = (await db.get(sql`SELECT count(*) AS n FROM delivered WHERE chat_id = ${BURST_CHANNEL}`)).n;
  const left = (await db.get(sql`SELECT count(*) AS n FROM outbox WHERE tg_channel_id = ${BURST_CHANNEL}`)).n;
  const mirrored = (await db.get(sql`SELECT count(*) AS n FROM mirrored WHERE tg_chat_id = ${BURST_CHANNEL}`)).n;
  const sends = await db.get(sql`
    SELECT count(*) AS attempts, count(DISTINCT call_id) AS calls, sum(CASE WHEN ok = 1 THEN 1 ELSE 0 END) AS ok
    FROM bale_calls WHERE method = 'sendMessage' AND chat_id = ${owner.baleChatId} AND id > ${Number(st.fromCallId) || 0}`);
  const errors = (await getSetting('errors', [])).filter((e) => e.at * 1000 >= st.atMs - 1000)
    .map((e) => `${e.where}: ${e.name} ${e.msg}`.slice(0, 120));
  // What happened, from the debug events.
  // Events are cleared at prepare: no time filter (machine clocks may differ).
  const ev = await db.all(sql`SELECT * FROM debug_events ORDER BY id`);
  const multi = (kind) => {
    const n = new Map();
    for (const e of ev) if (e.kind === kind) n.set(e.key, (n.get(e.key) || 0) + 1);
    return [...n.values()].filter((v) => v > 1).length;
  };
  // Overlapping lock holders: an acquire while another run's acquire has no release yet.
  let held = new Map();
  let overlaps = 0;
  for (const e of ev) {
    if (e.kind === 'acquire') {
      if ([...held.keys()].some((r) => r !== e.run_id)) overlaps++;
      held.set(e.run_id, true);
    } else if (e.kind === 'release') held.delete(e.run_id);
  }
  // Each job sent twice: ms between the sends, same run (isolate) or not,
  // and whether the first send was marked done before the second.
  const twice = [];
  const byJob = new Map();
  for (const e of ev) if (e.kind === 'send' || e.kind === 'done') {
    if (!byJob.has(e.key)) byJob.set(e.key, []);
    byJob.get(e.key).push(e);
  }
  for (const list of byJob.values()) {
    const s = list.filter((e) => e.kind === 'send');
    if (s.length < 2) continue;
    twice.push({
      gapMs: s[1].at_ms - s[0].at_ms,
      sameRun: s[0].run_id === s[1].run_id,
      doneBefore: list.some((e) => e.kind === 'done' && e.id > s[0].id && e.id < s[1].id),
      doneCount: list.filter((e) => e.kind === 'done').length,
    });
  }
  const acq = new Map();
  for (const e of ev) if (e.kind === 'acquire' || e.kind === 'release') acq.set(e.run_id, (acq.get(e.run_id) || 0) + (e.kind === 'acquire' ? 1 : -1));
  const debug = {
    events: ev.length, claims: ev.filter((e) => e.kind === 'claim').length, claimedTwice: multi('claim'),
    jobs: ev.filter((e) => e.kind === 'job').length, queuedTwice: multi('job'),
    sends: ev.filter((e) => e.kind === 'send').length, jobSentTwice: multi('send'),
    acquires: ev.filter((e) => e.kind === 'acquire').length, lockOverlaps: overlaps,
    // Clock check: event times relative to the prepare run's clock.
    firstEventMinusPrepareMs: ev.length ? ev[0].at_ms - st.atMs : null,
    runs: new Set(ev.map((e) => e.run_id)).size,
    dones: ev.filter((e) => e.kind === 'done').length,
    unreleasedRuns: [...acq.values()].filter((v) => v > 0).length,
    twice: twice.slice(0, 8),
  };
  await db.run(sql`DELETE FROM debug_events`);
  const deleted = await cleanupBurst(owner.baleChatId, Number(st.fromCallId) || 0);
  return { ok: true, claimed, queuedLeft: left, mirrored, sent: sends, duplicates: (sends.ok || 0) - mirrored, errors, debug, deletedAfter: deleted };
}

// Which Telegram answers show that a channel post was deleted (CI
// `__probe_methods`). The usual check answered "can't be edited" for a post
// deleted minutes ago until the next post arrived (a stale copy on
// Telegram's side). Tried on each channel's newest post, none of them visible
// in the channel; the last one (forward to the owner, removed at once) is
// the ground truth. Answers only: no ids, no contents.
export async function runProbeMethods() {
  const answer = async (fn) => {
    const t0 = Date.now();
    try {
      const r = await fn();
      return ['ok', Date.now() - t0, r];
    } catch (e) {
      return [`${e && e.code} ${String((e && e.description) || e).slice(0, 60)}`, Date.now() - t0];
    }
  };
  const out = [];
  const t = Math.floor(Date.now() / 1000);
  for (const ch of await db.all(sql`SELECT tg_channel_id, owner_tg_id FROM channels WHERE tg_channel_id != -42`)) {
    const chat = ch.tg_channel_id;
    const last = await db.get(sql`SELECT max(message_id) AS id, max(created_at) AS at FROM delivered WHERE chat_id = ${chat}`);
    if (!last || !last.id) continue;
    const mid = Number(last.id);
    const r = { seenAgoS: t - last.at };
    r.edit1 = await answer(() => api.editMessageReplyMarkup({ chat_id: chat, message_id: mid }));
    r.react = await answer(() => api.setMessageReaction({ chat_id: chat, message_id: mid, reaction: [] }));
    r.edit2 = await answer(() => api.editMessageReplyMarkup({ chat_id: chat, message_id: mid }));
    const g = await answer(() => api.getChat({ chat_id: chat }));
    r.getChat = g.slice(0, 2);
    r.edit3 = await answer(() => api.editMessageReplyMarkup({ chat_id: chat, message_id: mid }));
    const f = await answer(() => api.forwardMessage({ chat_id: ch.owner_tg_id, from_chat_id: chat, message_id: mid, disable_notification: true }));
    if (f[0] === 'ok' && f[2] && f[2].message_id) await api.deleteMessage({ chat_id: ch.owner_tg_id, message_id: f[2].message_id }).catch(() => null);
    r.forward = f.slice(0, 2);
    r.edit4 = await answer(() => api.editMessageReplyMarkup({ chat_id: chat, message_id: mid }));
    for (const k of ['edit1', 'react', 'edit2', 'edit3', 'edit4']) r[k] = r[k].slice(0, 2);
    out.push(r);
  }
  return out;
}
