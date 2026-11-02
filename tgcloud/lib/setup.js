// Deploy-time setup and smoke check, run from CI with
//   npx tgcloud run handlers/message '{ __setup: true }'
// It checks Bale's webhook is off (CI clears it with curl), registers the Telegram
// command menu and reports what works. The result contains no secrets.

import { api, db } from 'sdk';
import { sql } from 'sdk/db';
import { baleCall, safeErrorText } from './bale.js';
import { OWNER_TELEGRAM_ID } from './config.js';
import { createCode, getOrCreateCode, extractCode, consumeCode } from './linking.js';
import {
  touchUser, getUser, setLink, clearLink, claimMessage, acquirePollLock, releasePollLock,
} from './store.js';
import { splitText } from './util.js';

const USER_COMMANDS = [
  { command: 'start', description: 'شروع و اتصال حساب بله' },
  { command: 'link', description: 'گرفتن کد اتصال جدید' },
  { command: 'status', description: 'وضعیت اتصال' },
  { command: 'test', description: 'ارسال پیام آزمایشی به بله' },
  { command: 'unlink', description: 'قطع اتصال حساب بله' },
  { command: 'help', description: 'راهنما' },
];

const OWNER_COMMANDS = [
  ...USER_COMMANDS,
  { command: 'stats', description: 'آمار (مدیر)' },
  { command: 'users', description: 'فهرست کاربران (مدیر)' },
  { command: 'block', description: 'مسدود کردن کاربر (مدیر)' },
  { command: 'unblock', description: 'رفع مسدودی کاربر (مدیر)' },
];

async function step(fn) {
  try {
    return await fn();
  } catch (e) {
    return { ok: false, error: safeErrorText(e), code: e && e.code };
  }
}

export async function runSetup() {
  const out = {
    runtime: {
      setTimeout: typeof setTimeout,
      cryptoRandom: typeof (globalThis.crypto && globalThis.crypto.getRandomValues),
    },
  };

  out.telegramBot = await step(async () => {
    const me = await api.getMe();
    return { ok: true, username: me.username };
  });

  out.baleWebhookInfo = await step(async () => {
    const r = await baleCall('getWebhookInfo', {});
    return r.ok ? { ok: true, urlEmpty: !(r.result && r.result.url) } : { ok: false, code: r.error_code };
  });

  out.commands = await step(async () => {
    await api.setMyCommands({ commands: USER_COMMANDS });
    await api.setMyCommands({ commands: OWNER_COMMANDS, scope: { type: 'chat', chat_id: OWNER_TELEGRAM_ID } })
      .catch(() => null); // fails until the owner has started the bot
    return { ok: true };
  });

  // Counts only — no ids or contents.
  out.database = await step(async () => {
    const t = Math.floor(Date.now() / 1000);
    const u = await db.get(sql`
      SELECT count(*) AS users,
             sum(CASE WHEN bale_chat_id IS NOT NULL THEN 1 ELSE 0 END) AS linked
      FROM users`);
    const c = await db.get(sql`
      SELECT sum(CASE WHEN used_at IS NULL AND expires_at > ${t} THEN 1 ELSE 0 END) AS pending,
             sum(CASE WHEN used_at IS NULL AND expires_at <= ${t} THEN 1 ELSE 0 END) AS expired,
             sum(CASE WHEN used_at IS NOT NULL THEN 1 ELSE 0 END) AS used
      FROM codes`);
    const s = await db.get(sql`SELECT update_offset, lock_until, consecutive_failures FROM bale_state WHERE id = 1`);
    return {
      ok: true,
      users: u.users, linked: u.linked || 0,
      codes: { pending: c.pending || 0, expired: c.expired || 0, used: c.used || 0 },
      baleOffset: s && s.update_offset,
      lockHeld: Boolean(s && s.lock_until > t),
      baleFailuresInRow: s && s.consecutive_failures,
    };
  });

  // Peek at Bale's queue without confirming anything (same offset).
  out.balePending = await step(async () => {
    const s = await db.get(sql`SELECT update_offset FROM bale_state WHERE id = 1`);
    const r = await baleCall('getUpdates', { offset: (s && s.update_offset) || 0, limit: 100, timeout: 0 });
    if (!r.ok) return { ok: false, code: r.error_code };
    const list = Array.isArray(r.result) ? r.result : [];
    return { ok: true, count: list.length, withText: list.filter((x) => x.message && x.message.text).length };
  });

  out.importOldLinks = await step(importOldLinks);
  out.selfTest = await step(selfTest);

  return out;
}

// Carries links made by the previous version of the bot (table `links`) over
// to `users`. Idempotent: users who already have a row are left alone.
async function importOldLinks() {
  const exists = await db.get(sql`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'links'`);
  if (!exists) return { ok: true, imported: 0 };
  const r = await db.run(sql`
    INSERT OR IGNORE INTO users (tg_id, bale_chat_id, linked_at, created_at, last_seen_at)
    SELECT tg_user_id, bale_chat_id, t, t, t FROM (
      SELECT tg_user_id, bale_chat_id,
             CASE WHEN linked_at > 100000000000 THEN linked_at / 1000 ELSE linked_at END AS t
      FROM links WHERE bale_chat_id IS NOT NULL
    )`);
  return { ok: true, imported: r.rowsAffected };
}

// Exercises the database helpers with a fake user id (-1), then cleans up.
async function selfTest() {
  const fake = -1;
  const checks = {};
  try {
    const u = await touchUser(fake);
    checks.touchUser = u && u.tgId === fake && u.blocked === false;

    const { code } = await createCode(fake);
    checks.reuseCode = (await getOrCreateCode(fake)).code === code;
    const extracted = extractCode('/start ' + code.toLowerCase().slice(0, 4) + ' ' + code.slice(4));
    checks.extractCode = extracted === code;
    checks.consumeOnce = (await consumeCode(code)) === fake;
    checks.consumeTwice = (await consumeCode(code)) === null;

    checks.claimFirst = (await claimMessage(fake, 1)) === true;
    checks.claimRepeat = (await claimMessage(fake, 1)) === false;

    await setLink(fake, 12345);
    checks.setLink = (await getUser(fake)).baleChatId === 12345;
    await clearLink(fake);
    checks.clearLink = (await getUser(fake)).baleChatId === null;

    const parts = splitText('a'.repeat(9000), 4000);
    checks.splitText = parts.length === 3 && parts.join('') === 'a'.repeat(9000);

    const lock1 = await acquirePollLock(5);
    const lock2 = await acquirePollLock(5);
    if (lock1) await releasePollLock();
    checks.pollLock = lock1 === true && lock2 === false;
  } finally {
    await db.run(sql`DELETE FROM users WHERE tg_id = ${fake}`);
    await db.run(sql`DELETE FROM codes WHERE tg_id = ${fake}`);
    await db.run(sql`DELETE FROM delivered WHERE chat_id = ${fake}`);
  }
  return { ok: Object.values(checks).every(Boolean), checks };
}
