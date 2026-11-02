// Linking a Telegram user to a Bale chat with single-use codes.
//
// Bale can't push to us (the platform only hosts the Telegram webhook), so
// pending Bale messages are pulled with getUpdates whenever someone presses
// the verify button. One pass handles every pending update, for all users.

import { db, api } from 'sdk';
import { and, eq, gt, isNull, desc, sql } from 'sdk/db';
import { linkCodes } from '../schema.js';
import { baleCall, classifyError, isSystemError } from './bale.js';
import {
  acquirePollLock, releasePollLock, getBaleState, saveOffset, setLink,
  recordBaleSuccess, recordBaleFailure,
} from './store.js';
import { T } from './texts.js';
import { now, rowsOf, toAsciiDigits } from './util.js';

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
const CODE_LENGTH = 8;
const CODE_TTL_SECONDS = 10 * 60;
const REUSE_MIN_SECONDS_LEFT = 3 * 60;
const POLL_LOCK_SECONDS = 25;
const MAX_POLL_PAGES = 3;

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

// Creates a fresh code for the user, dropping their older unused ones.
export async function createCode(tgId) {
  const t = now();
  await db.delete(linkCodes).where(and(eq(linkCodes.tgId, tgId), isNull(linkCodes.usedAt))).run();
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode();
    const r = await db.run(
      sql`INSERT OR IGNORE INTO codes (code, tg_id, created_at, expires_at) VALUES (${code}, ${tgId}, ${t}, ${t + CODE_TTL_SECONDS})`
    );
    if (r.rowsAffected > 0) return { code, minutesLeft: CODE_TTL_SECONDS / 60 };
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
    .where(and(eq(linkCodes.tgId, tgId), isNull(linkCodes.usedAt), gt(linkCodes.expiresAt, now())))
    .orderBy(desc(linkCodes.expiresAt))
    .get();
}

export async function hasPendingCode(tgId) {
  return Boolean(await pendingCode(tgId));
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

// Atomically consumes a valid code. Returns the Telegram id or null.
export async function consumeCode(code) {
  const t = now();
  const r = await db.run(
    sql`UPDATE codes SET used_at = ${t} WHERE code = ${code} AND used_at IS NULL AND expires_at > ${t} RETURNING tg_id`
  );
  const row = rowsOf(r)[0];
  return row ? Number(row.tg_id) : null;
}

async function baleReply(chatId, text) {
  await baleCall('sendMessage', { chat_id: chatId, text });
}

async function handleBaleMessage(msg, linkedNow) {
  if (!msg || !msg.chat || msg.chat.type !== 'private') return;
  const chatId = msg.chat.id;
  const text = typeof msg.text === 'string' ? msg.text : '';
  const code = extractCode(text);

  if (code) {
    const tgId = await consumeCode(code);
    if (tgId) {
      await setLink(tgId, chatId);
      linkedNow.add(tgId);
      await baleReply(chatId, T.baleLinked);
      return;
    }
    await baleReply(chatId, T.baleBadCode);
    return;
  }

  // Not a code. Hint only chats that aren't linked yet, so linked users who
  // chat with the Bale bot don't get late, confusing replies.
  const linked = await db.get(sql`SELECT 1 AS x FROM users WHERE bale_chat_id = ${chatId} LIMIT 1`);
  if (!linked) await baleReply(chatId, T.baleHint);
}

// Processes every pending Bale update. Returns
// { status: 'ok' | 'busy' | 'error', linkedNow: Set<tgId>, reason? }.
export async function pollBale() {
  const linkedNow = new Set();
  if (!(await acquirePollLock(POLL_LOCK_SECONDS))) return { status: 'busy', linkedNow };
  try {
    const state = await getBaleState();
    let offset = Number(state.updateOffset) || 0;

    for (let page = 0; page < MAX_POLL_PAGES; page++) {
      const r = await baleCall('getUpdates', { offset, limit: 100, timeout: 0 });
      if (!r.ok) {
        const reason = classifyError(r);
        if (isSystemError(reason)) await recordBaleFailure('getUpdates/' + reason);
        return { status: 'error', linkedNow, reason };
      }
      await recordBaleSuccess();
      const updates = Array.isArray(r.result) ? r.result : [];
      if (!updates.length) break;

      for (const u of updates) {
        if (typeof u.update_id === 'number' && u.update_id + 1 > offset) offset = u.update_id + 1;
        try {
          await handleBaleMessage(u.message, linkedNow);
        } catch (e) {
          console.error('bale update failed', u.update_id, e && e.name);
        }
      }
      // Always advance, even when single updates failed: Bale keeps resending
      // unconfirmed updates otherwise.
      await saveOffset(offset);
      if (updates.length < 100) break;
    }
    return { status: 'ok', linkedNow };
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
