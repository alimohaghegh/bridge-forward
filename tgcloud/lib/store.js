// Database access: users, the redelivery guard, Bale state and alerts.

import { db, api } from 'sdk';
import { eq, sql } from 'sdk/db';
import { users, baleState } from '../schema.js';
import { OWNER_TELEGRAM_ID } from './config.js';
import { now, rowsOf } from './util.js';
import { cleanupAlbums } from './album.js';

const DELIVERED_RETENTION_SECONDS = 3 * 24 * 3600;
const CODE_RETENTION_SECONDS = 24 * 3600;
const ALERT_AFTER_FAILURES = 3;
const ALERT_INTERVAL_SECONDS = 3600;

export function isOwner(tgId) {
  return Number(tgId) === Number(OWNER_TELEGRAM_ID);
}

// Creates the user row if needed, bumps last_seen_at, returns the row.
export async function touchUser(tgId) {
  const t = now();
  const result = await db.insert(users)
    .values({ tgId, createdAt: t, lastSeenAt: t })
    .onConflictDoUpdate({ target: users.tgId, set: { lastSeenAt: t } })
    .returning()
    .run();
  return rowsOf(result)[0] || (await getUser(tgId));
}

export async function getUser(tgId) {
  return db.select().from(users).where(eq(users.tgId, tgId)).get();
}

export async function setLink(tgId, baleChatId) {
  const t = now();
  await db.insert(users)
    .values({ tgId, baleChatId, linkedAt: t, createdAt: t, lastSeenAt: t })
    .onConflictDoUpdate({ target: users.tgId, set: { baleChatId, linkedAt: t } })
    .run();
}

export async function clearLink(tgId) {
  await db.update(users).set({ baleChatId: null, linkedAt: null }).where(eq(users.tgId, tgId)).run();
}

export async function setBlocked(tgId, blocked) {
  const t = now();
  await db.insert(users)
    .values({ tgId, blocked, createdAt: t, lastSeenAt: t })
    .onConflictDoUpdate({ target: users.tgId, set: { blocked } })
    .run();
}

export async function countDelivery(tgId, ok) {
  if (ok) {
    await db.run(sql`UPDATE users SET delivered_count = delivered_count + 1 WHERE tg_id = ${tgId}`);
  } else {
    await db.run(sql`UPDATE users SET failed_count = failed_count + 1 WHERE tg_id = ${tgId}`);
  }
}

// Claims a Telegram message for processing. False = already seen (redelivery).
export async function claimMessage(chatId, messageId) {
  const r = await db.run(
    sql`INSERT OR IGNORE INTO delivered (chat_id, message_id, created_at) VALUES (${chatId}, ${messageId}, ${now()})`
  );
  return r.rowsAffected > 0;
}

// Occasional cleanup of old dedupe rows and spent codes.
export async function maybeCleanup() {
  if (Math.random() > 0.05) return;
  const t = now();
  await db.run(sql`DELETE FROM delivered WHERE created_at < ${t - DELIVERED_RETENTION_SECONDS}`);
  await db.run(sql`DELETE FROM codes WHERE expires_at < ${t - CODE_RETENTION_SECONDS}`);
  await cleanupAlbums();
}

// ── Bale state (single row, id = 1) ─────────────────────────────────────────

async function ensureStateRow() {
  await db.run(sql`INSERT OR IGNORE INTO bale_state (id) VALUES (1)`);
}

export async function getBaleState() {
  await ensureStateRow();
  return db.select().from(baleState).where(eq(baleState.id, 1)).get();
}

// A short lock so two button presses don't poll Bale at the same time.
export async function acquirePollLock(seconds) {
  await ensureStateRow();
  const t = now();
  const r = await db.run(
    sql`UPDATE bale_state SET lock_until = ${t + seconds} WHERE id = 1 AND lock_until < ${t}`
  );
  return r.rowsAffected > 0;
}

export async function releasePollLock() {
  await db.run(sql`UPDATE bale_state SET lock_until = 0 WHERE id = 1`);
}

export async function saveOffset(offset) {
  await db.run(sql`UPDATE bale_state SET update_offset = ${offset} WHERE id = 1 AND update_offset < ${offset}`);
}

export async function recordBaleSuccess() {
  await db.run(sql`UPDATE bale_state SET consecutive_failures = 0 WHERE id = 1 AND consecutive_failures != 0`);
}

// Counts a system-level Bale failure and alerts the owner (at most hourly)
// once failures pile up.
export async function recordBaleFailure(reason) {
  await ensureStateRow();
  const t = now();
  const r = await db.run(
    sql`UPDATE bale_state SET consecutive_failures = consecutive_failures + 1 WHERE id = 1 RETURNING consecutive_failures, last_alert_at`
  );
  const row = rowsOf(r)[0];
  if (!row || row.consecutive_failures < ALERT_AFTER_FAILURES) return;
  if (t - row.last_alert_at < ALERT_INTERVAL_SECONDS) return;
  const claimed = await db.run(
    sql`UPDATE bale_state SET last_alert_at = ${t} WHERE id = 1 AND last_alert_at = ${row.last_alert_at}`
  );
  if (claimed.rowsAffected === 0) return;
  try {
    await api.sendMessage({
      chat_id: OWNER_TELEGRAM_ID,
      text:
        `🚨 هشدار مدیر: ارتباط با بله ${row.consecutive_failures} بار پشت سر هم ناموفق بوده است.\n` +
        `آخرین نوع خطا: ${reason}\n` +
        '(این هشدار حداکثر هر یک ساعت یک بار فرستاده می‌شود.)',
    });
  } catch {
    // The owner may not have started the bot; nothing else to do.
  }
}
