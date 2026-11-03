// Linking with single-use codes: a Telegram user to their Bale chat, and a
// Telegram channel to a Bale channel or group (the code is posted there).
//
// Bale can't push to us (the platform only hosts the Telegram webhook), so
// pending Bale messages are pulled with getUpdates whenever someone presses
// the verify button. One pass handles every pending update, for all users.

import { db, api } from 'sdk';
import { and, eq, gt, isNull, desc, sql } from 'sdk/db';
import { linkCodes } from '../schema.js';
import { baleCall, baleCallOnce, classifyError, isSystemError } from './bale.js';
import {
  acquirePollLock, releasePollLock, getBaleState, saveOffset, setLink,
  recordBaleSuccess, recordBaleFailure,
} from './store.js';
import { linkBaleTarget } from './channels.js';
import { T } from './texts.js';
import { now, rowsOf, toAsciiDigits } from './util.js';

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
const CODE_LENGTH = 8;
const CODE_TTL_SECONDS = 10 * 60;
const REUSE_MIN_SECONDS_LEFT = 3 * 60;
const POLL_LOCK_SECONDS = 30;
const MAX_POLL_PAGES = 3;
// A handler run is capped near 30 s. Connecting to Bale from the platform is
// flaky (a failed attempt costs ~5 s), so the first getUpdates gets attempts
// until FETCH_RETRY_MS has passed, and update handling stops at POLL_BUDGET_MS.
const FETCH_RETRY_MS = 11000;
const POLL_BUDGET_MS = 22000;
const STALE_SECONDS = 15 * 60;

function randomCode() {
  const bytes = new Uint8Array(CODE_LENGTH);
  if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

// Creates a fresh account code for the user, dropping their older unused ones.
export async function createCode(tgId) {
  await db.run(sql`DELETE FROM codes WHERE tg_id = ${tgId} AND used_at IS NULL AND tg_channel_id IS NULL`);
  return insertCode(tgId, null);
}

// A code that links Telegram channel `tgChannelId` to the Bale channel or
// group it gets posted in.
export async function createChannelCode(tgId, tgChannelId) {
  await db.run(sql`DELETE FROM codes WHERE tg_id = ${tgId} AND used_at IS NULL AND tg_channel_id IS NOT NULL`);
  return insertCode(tgId, tgChannelId);
}

async function insertCode(tgId, tgChannelId) {
  const t = now();
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode();
    const r = await db.run(sql`
      INSERT OR IGNORE INTO codes (code, tg_id, created_at, expires_at, tg_channel_id)
      VALUES (${code}, ${tgId}, ${t}, ${t + CODE_TTL_SECONDS}, ${tgChannelId}) RETURNING code`);
    if (rowsOf(r).length > 0) return { code, minutesLeft: CODE_TTL_SECONDS / 60 };
  }
  throw new Error('could not allocate a link code');
}

// Reuses the user's pending code when it still has a few minutes left.
export async function getOrCreateCode(tgId) {
  const t = now();
  const pending = await pendingCode(tgId);
  if (pending && pending.expiresAt - t >= REUSE_MIN_SECONDS_LEFT) {
    return { code: pending.code, minutesLeft: Math.ceil((pending.expiresAt - t) / 60) };
  }
  return createCode(tgId);
}

async function pendingCode(tgId) {
  return db.select().from(linkCodes)
    .where(and(eq(linkCodes.tgId, tgId), isNull(linkCodes.usedAt), isNull(linkCodes.tgChannelId), gt(linkCodes.expiresAt, now())))
    .orderBy(desc(linkCodes.expiresAt))
    .get();
}

export async function hasPendingCode(tgId) {
  return Boolean(await pendingCode(tgId));
}

export async function hasPendingChannelCode(tgId) {
  const row = await db.get(sql`
    SELECT 1 AS x FROM codes
    WHERE tg_id = ${tgId} AND used_at IS NULL AND tg_channel_id IS NOT NULL AND expires_at > ${now()}`);
  return Boolean(row);
}

export async function deletePendingCodes(tgId) {
  await db.delete(linkCodes).where(and(eq(linkCodes.tgId, tgId), isNull(linkCodes.usedAt))).run();
}

// Pulls a code-shaped token out of a Bale message ("CODE" or "/start CODE").
export function extractCode(text) {
  let s = toAsciiDigits(String(text || '')).trim();
  const start = s.match(/^\/start(?:@\S+)?\s*(.*)$/i);
  if (start) s = start[1];
  s = s.replace(/[\s\-_.]/g, '').toUpperCase();
  return /^[A-Z0-9]{8}$/.test(s) ? s : null;
}

// Atomically consumes a valid code of the given kind (channel codes or
// account codes). Returns { tgId, tgChannelId } or null.
export async function consumeCode(code, { channel = false } = {}) {
  const t = now();
  const r = channel
    ? await db.run(sql`
        UPDATE codes SET used_at = ${t}
        WHERE code = ${code} AND used_at IS NULL AND expires_at > ${t} AND tg_channel_id IS NOT NULL
        RETURNING tg_id, tg_channel_id`)
    : await db.run(sql`
        UPDATE codes SET used_at = ${t}
        WHERE code = ${code} AND used_at IS NULL AND expires_at > ${t} AND tg_channel_id IS NULL
        RETURNING tg_id, tg_channel_id`);
  const row = rowsOf(r)[0];
  return row ? { tgId: Number(row.tg_id), tgChannelId: row.tg_channel_id === null ? null : Number(row.tg_channel_id) } : null;
}

async function isChannelCode(code) {
  const row = await db.get(sql`SELECT 1 AS x FROM codes WHERE code = ${code} AND tg_channel_id IS NOT NULL`);
  return Boolean(row);
}

async function baleReply(chatId, text) {
  await baleCall('sendMessage', { chat_id: chatId, text });
}

// A channel code posted in a Bale channel/group (or a post with it
// forwarded to the bot): links that chat to the user's Telegram channel.
async function handleChannelCode(code, target, sink) {
  const c = await consumeCode(code, { channel: true });
  if (!c) return false;
  const result = await linkBaleTarget(c.tgId, c.tgChannelId, target);
  sink.channelLinked.add(c.tgId);
  if (!result.ok) {
    sink.channelFailed.add(c.tgId);
    // Let the user fix the rights and post the same code again.
    await db.run(sql`UPDATE codes SET used_at = NULL WHERE code = ${code}`);
  }
  return true;
}

export async function handleBaleMessage(msg, sink) {
  if (!msg || !msg.chat) return;
  const chatId = msg.chat.id;
  const text = typeof msg.text === 'string' ? msg.text : (typeof msg.caption === 'string' ? msg.caption : '');
  const code = extractCode(text);

  // Codes posted in a Bale channel or group link that chat to a channel.
  if (msg.chat.type === 'channel' || msg.chat.type === 'group') {
    if (code) {
      await handleChannelCode(code, {
        chatId, type: msg.chat.type, title: msg.chat.title,
        posterId: msg.from && msg.from.id, codeMessageId: msg.message_id,
      }, sink);
    }
    return;
  }
  if (msg.chat.type !== 'private') return;

  // A post of a Bale channel forwarded to the bot while its user is at
  // step 2: link that channel — nothing has to be posted in it.
  const fwd = msg.forward_from_chat;
  if (!code && fwd && (fwd.type === 'channel' || fwd.type === 'group')) {
    const u = await db.get(sql`
      SELECT tg_id, pending_tg_channel FROM users
      WHERE bale_chat_id = ${chatId} AND pending_step = 'bale_channel' AND pending_until > ${now()} LIMIT 1`);
    if (u) {
      const tgId = Number(u.tg_id);
      const result = await linkBaleTarget(tgId, Number(u.pending_tg_channel), {
        chatId: fwd.id, type: fwd.type, title: fwd.title, userBaleId: chatId,
      });
      sink.channelLinked.add(tgId);
      if (!result.ok) sink.channelFailed.add(tgId);
      await baleReply(chatId, T.baleChannelLinkedHere);
      return;
    }
  }

  // A channel post with a code, forwarded to the bot: link that channel.
  if (code && fwd && (fwd.type === 'channel' || fwd.type === 'group')) {
    const handled = await handleChannelCode(code, {
      chatId: fwd.id, type: fwd.type, title: fwd.title,
      codeMessageId: msg.forward_from_message_id,
    }, sink);
    if (handled) {
      await baleReply(chatId, T.baleChannelLinkedHere);
      return;
    }
  }

  const linkedNow = sink.linkedNow;
  // Old messages (left in Bale's queue while nobody checked) get no replies:
  // their codes have expired anyway and a burst of late answers confuses.
  const stale = typeof msg.date === 'number' && now() - msg.date > STALE_SECONDS;

  if (code) {
    if (await isChannelCode(code)) {
      if (!stale) await baleReply(chatId, T.baleChannelCodeHere);
      return;
    }
    const consumed = await consumeCode(code);
    const tgId = consumed && consumed.tgId;
    if (tgId) {
      await setLink(tgId, chatId);
      linkedNow.add(tgId);
      await baleReply(chatId, T.baleLinked);
      return;
    }
    if (!stale) await baleReply(chatId, T.baleBadCode);
    return;
  }

  // Not a code. Hint only chats that aren't linked yet, so linked users who
  // chat with the Bale bot don't get late, confusing replies.
  const linked = await db.get(sql`SELECT 1 AS x FROM users WHERE bale_chat_id = ${chatId} LIMIT 1`);
  if (!linked && !stale) await baleReply(chatId, T.baleHint);
}

// Processes every pending Bale update. Returns { status: 'ok' | 'busy' |
// 'error', linkedNow: Set<tgId>, channelLinked: Set<tgId>, channelFailed:
// Set<tgId>, reason? } (channelLinked: users whose channel code was used;
// they have been told the outcome in Telegram already).
export async function pollBale() {
  const sink = { linkedNow: new Set(), channelLinked: new Set(), channelFailed: new Set() };
  const linkedNow = sink.linkedNow;
  const started = Date.now();
  const deadline = started + POLL_BUDGET_MS;
  if (!(await acquirePollLock(POLL_LOCK_SECONDS))) return { status: 'busy', ...sink };
  try {
    const state = await getBaleState();
    let offset = Number(state.updateOffset) || 0;

    for (let page = 0; page < MAX_POLL_PAGES; page++) {
      const params = { offset, limit: 100, timeout: 0 };
      let r = await baleCallOnce('getUpdates', params);
      while (!r.ok && r.network && Date.now() - started < FETCH_RETRY_MS) {
        r = await baleCallOnce('getUpdates', params);
      }
      if (!r.ok) {
        const reason = classifyError(r);
        if (isSystemError(reason)) await recordBaleFailure('getUpdates/' + reason);
        return { status: 'error', ...sink, reason };
      }
      await recordBaleSuccess();
      const updates = Array.isArray(r.result) ? r.result : [];
      if (!updates.length) break;

      for (const u of updates) {
        // Leave the rest for the next press rather than being cut off.
        if (Date.now() > deadline) return { status: 'ok', ...sink };
        // Advance before handling (at most once): if the run is cut off, an
        // update is skipped rather than answered twice. Bale keeps resending
        // unconfirmed updates otherwise.
        if (typeof u.update_id === 'number' && u.update_id + 1 > offset) {
          offset = u.update_id + 1;
          await saveOffset(offset);
        }
        try {
          // Channel posts aren't in Bale's documented Update, but accept them.
          await handleBaleMessage(u.message || u.channel_post, sink);
        } catch (e) {
          console.error('bale update failed', u.update_id, e && e.name);
        }
      }
      if (updates.length < 100) break;
    }
    return { status: 'ok', ...sink };
  } finally {
    await releasePollLock();
  }
}

// Tells Telegram users who were linked by someone else's poll pass.
export async function notifyLinked(tgIds, exceptTgId) {
  for (const tgId of tgIds) {
    if (tgId === exceptTgId) continue;
    try {
      await api.sendMessage({ chat_id: tgId, text: T.linkedFromOtherPass });
    } catch {
      // User may have blocked the bot.
    }
  }
}
