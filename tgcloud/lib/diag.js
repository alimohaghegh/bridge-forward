// Bale connectivity probe, for the owner's /diag command and CI
// (`npx tgcloud run handlers/message '{ __diag: true }'`).
// Reports per-attempt outcome and timing only: no tokens, ids or contents.

import { api, db } from 'sdk';
import { sql } from 'sdk/db';
import { baleCall, baleCallOnce, safeErrorText } from './bale.js';
import { OWNER_TELEGRAM_ID } from './config.js';
import { getUser } from './store.js';
import { getSetting } from './eitaa.js';
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
