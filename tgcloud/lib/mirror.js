// Channel mirroring: a durable, ordered queue from a Telegram channel to its
// linked Bale chat.
//
// Every post, album, edit and deletion becomes a job in `outbox`. Jobs run
// strictly in Telegram order, one sender per channel (a lock), and a job is
// removed only when Bale accepted it — or the failure can never succeed (a
// file over 20 MB, an unsupported post), which is reported. Bale being
// unreachable just leaves the job for the next try: on the next channel
// update, and on the scheduled run (GitHub Actions → __drain).
//
// Deletions: the Bot API sends no update when a channel post is deleted, so
// recent mirrored posts are probed — editMessageReplyMarkup on a post the
// bot didn't write answers "can't be edited" while it exists and "message
// to edit not found" (or, when it may edit, "MESSAGE_ID_INVALID") once it
// is gone (nothing is changed either way).

import { api, db } from 'sdk';
import { sql } from 'sdk/db';
import { baleCall, isSystemError } from './bale.js';
import {
  planMessage, planAlbum, runPlan, mediaSpec, captionParts, failure, formatChunks,
  editTextChunk, editCaption, sendTextChunk, BALE_TEXT_LIMIT,
} from './forward.js';
import { takeStaleAlbums, albumPending, releaseAlbumItems } from './album.js';
import { getChannel, countChannelDelivery, telegramChannelTitle } from './channels.js';
import { recordBaleSuccess, recordBaleFailure, noteError } from './store.js';
import { getSetting, setSetting } from './eitaa.js';
import { T } from './texts.js';
import { now, rowsOf, deletedPostAnswer, DB_NOW } from './util.js';

const LOCK_SECONDS = 40;
const PERMANENT = new Set(['too_large', 'download', 'unsupported', 'rejected']);
const ALERT_AFTER_ATTEMPTS = 2;
const STALE_ALBUM_MS = 30 * 1000;
const PROBE_WINDOW_SECONDS = 47 * 3600; // Bale deletes only messages < 48 h old
// Activity-driven probes run at most this often. The scheduled run (every
// minute) always probes: with a strict 60 s gap it was skipped whenever it
// came a second early, i.e. most of the time.
const PROBE_INTERVAL_SECONDS = 50;
const PROBE_BATCH = 25;
const PROBE_GRACE_MS = 3000;
const MIRROR_RETENTION_SECONDS = 30 * 24 * 3600;

// Burst test only (fake channel -42): records claim/queue/lock/send events.
const BURST = -42;
const RUN_ID = Math.random().toString(36).slice(2, 8);
async function dbg(channel, kind, key) {
  if (channel !== BURST) return;
  await db.run(sql`INSERT INTO debug_events (at_ms, kind, key, run_id) VALUES (${Date.now()}, ${kind}, ${key}, ${RUN_ID})`).catch(() => null);
}

// ── Enqueueing ──────────────────────────────────────────────────────────────

async function insertJob(tgChannelId, sortKey, kind, payload) {
  await dbg(tgChannelId, 'job', sortKey);
  await db.run(sql`
    INSERT INTO outbox (tg_channel_id, sort_key, kind, payload, created_at)
    VALUES (${tgChannelId}, ${sortKey}, ${kind}, ${payload === null ? null : JSON.stringify(payload)}, ${now()})`);
}

// True once a post is queued or mirrored (redelivered updates are skipped).
export async function alreadyQueued(tgChannelId, tgMessageId) {
  const seen = await db.get(sql`
    SELECT 1 AS x FROM delivered WHERE chat_id = ${tgChannelId} AND message_id = ${tgMessageId}`);
  return Boolean(seen);
}

async function markQueued(tgChannelId, tgMessageIds) {
  for (const id of tgMessageIds) {
    await db.run(sql`
      INSERT OR IGNORE INTO delivered (chat_id, message_id, created_at) VALUES (${tgChannelId}, ${id}, ${now()})`);
  }
}

// Returns false when the post can't be mirrored at all (sticker, poll…).
// The post is claimed first, in one statement: when Telegram delivers the
// same update twice at once (seen with bursts of posts), "check, then
// record" let both runs queue it and Bale got it twice.
export async function enqueuePost(tgChannelId, m) {
  const claimed = rowsOf(await db.run(sql`
    INSERT OR IGNORE INTO delivered (chat_id, message_id, created_at) VALUES (${tgChannelId}, ${m.message_id}, ${now()})
    RETURNING message_id`));
  if (!claimed.length) return true; // the other delivery has it
  await dbg(tgChannelId, 'claim', m.message_id);
  const plan = planMessage(m);
  if (plan) await insertJob(tgChannelId, m.message_id, 'post', { plan });
  return Boolean(plan);
}

export async function enqueueAlbum(tgChannelId, items) {
  if (!items.length) return;
  await insertJob(tgChannelId, items[0].tg, 'album', { plan: planAlbum(items) });
  await markQueued(tgChannelId, items.map((it) => it.tg));
  await releaseAlbumItems(tgChannelId, items);
}

export async function enqueueEdit(tgChannelId, m) {
  // Not sent yet: send the edited version instead.
  const pending = await db.get(sql`
    SELECT id, payload FROM outbox
    WHERE tg_channel_id = ${tgChannelId} AND sort_key = ${m.message_id} AND kind = 'post'`);
  if (pending) {
    const { plan } = JSON.parse(pending.payload);
    const fresh = planMessage(m);
    if (plan.next === 0 && fresh) {
      await db.run(sql`UPDATE outbox SET payload = ${JSON.stringify({ plan: fresh })} WHERE id = ${pending.id}`);
      return;
    }
  }
  // Only the latest edit matters.
  await db.run(sql`
    DELETE FROM outbox WHERE tg_channel_id = ${tgChannelId} AND sort_key = ${m.message_id} AND kind = 'edit'`);
  await insertJob(tgChannelId, m.message_id, 'edit', { message: m });
}

async function enqueueDelete(tgChannelId, tgMessageId) {
  const exists = await db.get(sql`
    SELECT 1 AS x FROM outbox WHERE tg_channel_id = ${tgChannelId} AND sort_key = ${tgMessageId} AND kind = 'delete'`);
  if (!exists) await insertJob(tgChannelId, tgMessageId, 'delete', null);
}

// ── Mirrored message map ────────────────────────────────────────────────────

async function getMirrored(tgChatId, tgMessageId) {
  const row = await db.get(sql`
    SELECT * FROM mirrored WHERE tg_chat_id = ${tgChatId} AND tg_message_id = ${tgMessageId}`);
  if (row) row.ids = JSON.parse(row.bale_ids);
  return row;
}

async function saveMirrored(tgChatId, tgMessageId, baleChatId, ids, layout, fileUid) {
  await db.run(sql`
    INSERT INTO mirrored (tg_chat_id, tg_message_id, bale_chat_id, bale_ids, layout, file_uid, created_at)
    VALUES (${tgChatId}, ${tgMessageId}, ${baleChatId}, ${JSON.stringify(ids)}, ${layout}, ${fileUid || null}, ${now()})
    ON CONFLICT (tg_chat_id, tg_message_id) DO UPDATE SET
      bale_chat_id = excluded.bale_chat_id, bale_ids = excluded.bale_ids,
      layout = excluded.layout, file_uid = excluded.file_uid, missing = 0`);
}

async function updateMirroredIds(row, ids, layout) {
  await db.run(sql`
    UPDATE mirrored SET bale_ids = ${JSON.stringify(ids)}, layout = ${layout || row.layout}
    WHERE tg_chat_id = ${row.tg_chat_id} AND tg_message_id = ${row.tg_message_id}`);
}

// ── Running jobs ────────────────────────────────────────────────────────────

async function runSend(link, job, payload, deadline) {
  const { plan } = payload;
  const r = await runPlan(link.baleChatId, plan, {
    deadline,
    onProgress: (p) => db.run(sql`UPDATE outbox SET payload = ${JSON.stringify({ plan: p })} WHERE id = ${job.id}`),
  });
  if (!r.ok) return r;
  for (const tg of Object.keys(plan.layout)) {
    await saveMirrored(link.tgChannelId, Number(tg), link.baleChatId, plan.ids[tg] || [], plan.layout[tg], plan.fileUid[tg]);
  }
  return { ok: true };
}

// The last few Bale delete answers (time, code, short text; no content),
// for diagnosis (__bale_state): a refusal used to pass for "already gone".
async function noteDelete(r, ids) {
  try {
    const list = await getSetting('bale_deletes', []);
    list.unshift({
      at: now(), ...ids, ok: r.ok === true, result: r.ok ? r.result : undefined, code: r.error_code,
      desc: r.ok ? undefined : String(r.description || r.detail || '').slice(0, 80), via: r.via,
    });
    await setSetting('bale_deletes', list.slice(0, 10));
  } catch {
    // Diagnosis only.
  }
}

// `why`: delete (the Telegram post was deleted) | edit-part (an edit made the
// text shorter) | edit-media (the file was replaced; the old copy goes).
async function deleteBale(chatId, baleId, tgId, why) {
  const r = await baleCall('deleteMessage', { chat_id: chatId, message_id: baleId });
  await noteDelete(r, { tg: tgId, bale: baleId, why });
  if (r.ok && r.result !== false) return { ok: true };
  // Already gone: nothing more to do.
  if (!r.ok && r.error_code === 400 && /not found|message_id_invalid/i.test(String(r.description))) return { ok: true };
  // Anything else (no right, too old for Bale's 48 h limit, …) is a real
  // refusal: reported to the owner instead of silently counted as done.
  if (r.ok || r.error_code === 400) return { ok: false, reason: 'rejected', description: r.description };
  return r;
}

// Brings Bale text messages `ids` in line with `chunks`: edits in place,
// appends extra chunks, deletes surplus messages. Returns { ok, ids }.
async function syncTextParts(chatId, ids, chunks, row, layout) {
  ids = ids.slice();
  for (let i = 0; i < chunks.length; i++) {
    if (i < ids.length) {
      const r = await editTextChunk(chatId, ids[i], chunks[i]);
      if (!r.ok) return r;
    } else {
      const r = await sendTextChunk(chatId, chunks[i]);
      if (!r.ok) return r;
      ids.push(r.sent[0][1]);
      await updateMirroredIds(row, row.prefix.concat(ids), layout);
    }
  }
  while (ids.length > chunks.length) {
    const r = await deleteBale(chatId, ids[ids.length - 1], row.tg_message_id, 'edit-part');
    if (!r.ok) return r;
    ids.pop();
    await updateMirroredIds(row, row.prefix.concat(ids), layout);
  }
  return { ok: true, ids };
}

async function runEdit(link, m, deadline) {
  const row = await getMirrored(link.tgChannelId, m.message_id);
  if (!row) return { ok: true }; // never mirrored (e.g. posted before linking)
  const chatId = row.bale_chat_id;

  if (typeof m.text === 'string' && m.text.length) {
    if (row.layout !== 'text') return { ok: true };
    row.prefix = [];
    const r = await syncTextParts(chatId, row.ids, formatChunks(m.text, m.entities, BALE_TEXT_LIMIT), row, 'text');
    return r.ok ? { ok: true } : failure(r);
  }

  const spec = mediaSpec(m);
  if (!spec || (row.layout !== 'media' && row.layout !== 'media+text')) return { ok: true };

  // The file itself was replaced. Bale can't swap media, so send the new
  // version and remove the old one.
  if (spec.fileUid && row.file_uid && spec.fileUid !== row.file_uid) {
    const plan = planMessage(m);
    const r = await runPlan(chatId, plan, { deadline });
    if (!r.ok) return r;
    await saveMirrored(link.tgChannelId, m.message_id, chatId, plan.ids[m.message_id] || [], plan.layout[m.message_id], spec.fileUid);
    for (const id of row.ids) {
      const d = await deleteBale(chatId, id, m.message_id, 'edit-media');
      if (!d.ok) return failure(d);
    }
    return { ok: true };
  }

  // Caption edit.
  const cp = captionParts(m);
  const [mediaId, ...textIds] = row.ids;
  row.prefix = [mediaId];
  if (row.layout === 'media' && !spec.noCaption && cp.fits) {
    const r = await editCaption(chatId, mediaId, cp.caption);
    return r.ok ? { ok: true } : failure(r);
  }
  if (row.layout === 'media') {
    // Too long for a caption now: clear it and send the text after the media.
    const r = await editCaption(chatId, mediaId, '');
    if (!r.ok) return failure(r);
  }
  const chunks = cp.chunks;
  const r = await syncTextParts(chatId, textIds, chunks, row, chunks.length ? 'media+text' : 'media');
  return r.ok ? { ok: true } : failure(r);
}

async function runDelete(link, tgMessageId) {
  const row = await getMirrored(link.tgChannelId, tgMessageId);
  if (!row) return { ok: true };
  for (const id of row.ids) {
    const r = await deleteBale(row.bale_chat_id, id, tgMessageId, 'delete');
    if (!r.ok) return failure(r);
  }
  await db.run(sql`DELETE FROM mirrored WHERE tg_chat_id = ${link.tgChannelId} AND tg_message_id = ${tgMessageId}`);
  return { ok: true };
}

async function runJob(link, job, deadline) {
  const payload = job.payload ? JSON.parse(job.payload) : null;
  if (job.kind === 'post' || job.kind === 'album') return runSend(link, job, payload, deadline);
  if (job.kind === 'edit') return runEdit(link, payload.message, deadline);
  if (job.kind === 'delete') return runDelete(link, job.sort_key);
  return { ok: true };
}

// ── Draining ────────────────────────────────────────────────────────────────

// The channel's sender lock. Success is read from the rows the statement
// returns, never from rowsAffected: that count was seen to be wrong under
// concurrent runs (two runs "held" the lock and sent the same job). The
// token makes release only free the lock its own run holds.
function newToken() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

async function acquire(tgChannelId, token) {
  const rows = rowsOf(await db.run(sql`
    UPDATE channels SET lock_until = ${DB_NOW} + ${LOCK_SECONDS}, lock_owner = ${token}
    WHERE tg_channel_id = ${tgChannelId} AND lock_until < ${DB_NOW}
    RETURNING lock_owner`));
  const ok = rows.length > 0 && rows[0].lock_owner === token;
  if (ok) await dbg(tgChannelId, 'acquire', 0);
  return ok;
}

async function release(tgChannelId, token) {
  await dbg(tgChannelId, 'release', 0);
  await db.run(sql`
    UPDATE channels SET lock_until = 0, lock_owner = NULL WHERE tg_channel_id = ${tgChannelId} AND lock_owner = ${token}`);
}

// Leases one job to this run (a second safety net next to the lock).
async function leaseJob(job, token) {
  const rows = rowsOf(await db.run(sql`
    UPDATE outbox SET lease_owner = ${token}, lease_until = ${DB_NOW} + ${LOCK_SECONDS}
    WHERE id = ${job.id} AND (lease_until < ${DB_NOW} OR lease_owner = ${token})
    RETURNING lease_owner`));
  return rows.length > 0 && rows[0].lease_owner === token;
}

async function unleaseJob(job, token) {
  await db.run(sql`UPDATE outbox SET lease_until = 0, lease_owner = NULL WHERE id = ${job.id} AND lease_owner = ${token}`);
}

async function notifyOwner(link, text) {
  await api.sendMessage({ chat_id: link.ownerTgId, text }).catch(() => null);
}

async function drainLocked(link, deadline, token) {
  for (const items of await takeStaleAlbums(link.tgChannelId, STALE_ALBUM_MS)) {
    await enqueueAlbum(link.tgChannelId, items);
  }

  let recovered = false;
  for (;;) {
    const job = await db.get(sql`
      SELECT * FROM outbox WHERE tg_channel_id = ${link.tgChannelId} ORDER BY sort_key, id LIMIT 1`);
    if (!job) break;
    if (Date.now() > deadline) return { status: 'timeout' };
    // An older album is still being collected: it goes first.
    if ((job.kind === 'post' || job.kind === 'album') && (await albumPending(link.tgChannelId, job.sort_key))) {
      return { status: 'waiting' };
    }

    // Another run has this job (it shouldn't, holding the lock — but if it
    // does, it must not be sent twice).
    if (!(await leaseJob(job, token))) return { status: 'busy' };
    let r;
    await dbg(link.tgChannelId, 'send', job.id);
    try {
      r = await runJob(link, job, deadline);
    } catch (e) {
      console.error('mirror job failed', job.kind, e && e.name);
      await noteError('mirror job ' + job.kind, e);
      r = { ok: false, reason: 'unavailable' };
    }

    if (r.ok) {
      await db.run(sql`DELETE FROM outbox WHERE id = ${job.id}`);
      await dbg(link.tgChannelId, 'done', job.id);
      if (job.kind === 'post' || job.kind === 'album') await countChannelDelivery(link.tgChannelId, true);
      await recordBaleSuccess();
      if (job.alerted) recovered = true;
      continue;
    }
    if (r.reason === 'timeout') {
      await unleaseJob(job, token);
      return { status: 'timeout' };
    }

    const title = await telegramChannelTitle(link.tgChannelId);
    const reasonText = T.chFailReasons[r.reason] || T.fail[r.reason] || T.fail.rejected;
    if (PERMANENT.has(r.reason)) {
      // Can never succeed: report it and move on, so later posts aren't blocked.
      await db.run(sql`DELETE FROM outbox WHERE id = ${job.id}`);
      if (job.kind === 'post' || job.kind === 'album') await countChannelDelivery(link.tgChannelId, false);
      // A refused deletion: forget the post, or every probe would find it
      // gone again and repeat the notice.
      if (job.kind === 'delete') {
        await db.run(sql`DELETE FROM mirrored WHERE tg_chat_id = ${link.tgChannelId} AND tg_message_id = ${job.sort_key}`);
      }
      await notifyOwner(link, T.chFail(title, T.chJobKind[job.kind], reasonText));
      continue;
    }

    // Temporary (Bale unreachable, rate limit, missing rights): keep it.
    await unleaseJob(job, token);
    const attempts = job.attempts + 1;
    await db.run(sql`UPDATE outbox SET attempts = ${attempts}, last_reason = ${r.reason} WHERE id = ${job.id}`);
    if (isSystemError(r.reason)) await recordBaleFailure('mirror/' + r.reason);
    if (attempts >= ALERT_AFTER_ATTEMPTS && !job.alerted) {
      await db.run(sql`UPDATE outbox SET alerted = 1 WHERE id = ${job.id}`);
      await notifyOwner(link, T.chPending(title, r.reason === 'chat' ? reasonText : ''));
    }
    return { status: 'retry', reason: r.reason };
  }

  if (recovered) await notifyOwner(link, T.chRecovered(await telegramChannelTitle(link.tgChannelId)));
  return { status: 'empty' };
}

// Probes recently mirrored posts and queues deletions for the ones gone.
// Probe counts of this isolate's runs, for the scheduled run's output.
export const probeStats = { runs: 0, checked: 0, gone: 0 };

async function probeDeletions(link, deadline, force) {
  const t = now();
  const claimed = rowsOf(await db.run(sql`
    UPDATE channels SET probed_at = ${DB_NOW}
    WHERE tg_channel_id = ${link.tgChannelId} AND (${force ? 1 : 0} = 1 OR probed_at < ${DB_NOW} - ${PROBE_INTERVAL_SECONDS})
    RETURNING probed_at`));
  if (!claimed.length) return 0;
  probeStats.runs++;

  const rows = rowsOf(await db.all(sql`
    SELECT tg_message_id FROM mirrored
    WHERE tg_chat_id = ${link.tgChannelId} AND created_at > ${t - PROBE_WINDOW_SECONDS}
    ORDER BY checked_at LIMIT ${PROBE_BATCH}`));
  let gone = 0;
  for (const row of rows) {
    if (Date.now() > deadline) break;
    const mid = Number(row.tg_message_id);
    // Asked twice, so a one-off glitch can't delete a post.
    if ((await postGone(link.tgChannelId, mid)) && (await postGone(link.tgChannelId, mid))) {
      await enqueueDelete(link.tgChannelId, mid);
      gone++;
      probeStats.gone++;
    }
    probeStats.checked++;
    await db.run(sql`
      UPDATE mirrored SET checked_at = ${now()} WHERE tg_chat_id = ${link.tgChannelId} AND tg_message_id = ${mid}`);
  }
  return gone;
}

async function postGone(chatId, messageId) {
  try {
    await api.editMessageReplyMarkup({ chat_id: chatId, message_id: messageId });
    return false;
  } catch (e) {
    return deletedPostAnswer(e);
  }
}

// Sends what is queued for one channel. Safe to call from any run: if
// another run holds the channel, this one returns 'busy'. No new send
// starts after `deadline` (a send can take ~20 s while Bale is flaky, and a
// run is cut off near 30 s). With `probe`, also checks for deleted posts
// once the queue is empty.
export async function drain(tgChannelId, { deadline, probe, forceProbe } = {}) {
  deadline = deadline || Date.now() + 8000;
  let result = { status: 'busy' };
  for (let round = 0; round < 3; round++) {
    const link = await getChannel(tgChannelId);
    if (!link) return { status: 'unlinked' };
    const token = newToken();
    if (!(await acquire(tgChannelId, token))) return result;
    try {
      result = await drainLocked(link, deadline, token);
      // Probing is quick (Telegram only), so it may run a little past the
      // deadline; the deletions it finds are applied now if time is left,
      // else on the next run.
      if (result.status === 'empty' && probe) {
        const gone = await probeDeletions(link, deadline + PROBE_GRACE_MS, forceProbe);
        if (gone > 0 && Date.now() < deadline) result = await drainLocked(link, deadline, token);
      }
    } finally {
      await release(tgChannelId, token);
    }
    // A job queued while this run held the lock saw 'busy': pick it up now.
    if (result.status !== 'empty' || Date.now() > deadline) return result;
    const more = await db.get(sql`SELECT 1 AS x FROM outbox WHERE tg_channel_id = ${tgChannelId} LIMIT 1`);
    if (!more) return result;
  }
  return result;
}

// Scheduled run / owner /sync: every linked channel, queue and deletions.
// The scheduled run's budget: room for a burst of deletions (a Bale delete
// takes ~0.3-0.6 s) while staying well under the ~30 s run limit.
export async function drainAll(budgetMs) {
  const end = Date.now() + (budgetMs || 20000);
  const out = {};
  const list = rowsOf(await db.all(sql`SELECT tg_channel_id FROM channels`));
  for (const row of list) {
    if (Date.now() > end) break;
    const id = Number(row.tg_channel_id);
    const r = await drain(id, { deadline: Math.min(end, Date.now() + 14000), probe: true, forceProbe: true });
    out[id] = r.status;
  }
  await db.run(sql`DELETE FROM mirrored WHERE created_at < ${now() - MIRROR_RETENTION_SECONDS}`);
  return out;
}

// Counts for the smoke check / owner stats (no contents).
export async function queueStats() {
  const q = await db.get(sql`
    SELECT count(*) AS jobs, coalesce(max(attempts), 0) AS max_attempts, min(created_at) AS oldest FROM outbox`);
  const m = await db.get(sql`SELECT count(*) AS n FROM mirrored`);
  return { jobs: q.jobs, maxAttempts: q.max_attempts, oldestAgeSeconds: q.oldest ? now() - q.oldest : 0, mirrored: m.n };
}

