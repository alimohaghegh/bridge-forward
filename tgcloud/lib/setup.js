// Deploy-time setup and smoke check, run from CI with
//   npx tgcloud run handlers/message '{ __setup: true }'
// It checks Bale's webhook is off (CI clears it with curl), registers the Telegram
// command menu and reports what works. The result contains no secrets.

import { api, db } from 'sdk';
import { sql } from 'sdk/db';
import { baleCall, safeErrorText } from './bale.js';
import { OWNER_TELEGRAM_ID } from './config.js';
import { createCode, createChannelCode, getOrCreateCode, extractCode, consumeCode } from './linking.js';
import {
  touchUser, getUser, setLink, clearLink, claimMessage, acquirePollLock, releasePollLock,
} from './store.js';
import { splitText } from './util.js';
import { toBaleMarkdown, formatChunks } from './format.js';
import { planMessage, planAlbum } from './forward.js';
import { queueStats } from './mirror.js';

const USER_COMMANDS = [
  { command: 'start', description: 'شروع و اتصال حساب بله' },
  { command: 'link', description: 'گرفتن کد اتصال جدید' },
  { command: 'status', description: 'وضعیت اتصال' },
  { command: 'test', description: 'ارسال پیام آزمایشی به بله' },
  { command: 'unlink', description: 'قطع اتصال حساب بله' },
  { command: 'channel', description: 'اتصال کانال تلگرام به کانال بله' },
  { command: 'channels', description: 'کانال‌های متصل و قطع اتصال' },
  { command: 'cancel', description: 'لغو کار در جریان' },
  { command: 'help', description: 'راهنما' },
];

const OWNER_COMMANDS = [
  ...USER_COMMANDS,
  { command: 'stats', description: 'آمار (مدیر)' },
  { command: 'users', description: 'فهرست کاربران (مدیر)' },
  { command: 'block', description: 'مسدود کردن کاربر (مدیر)' },
  { command: 'unblock', description: 'رفع مسدودی کاربر (مدیر)' },
  { command: 'diag', description: 'بررسی اتصال به بله (مدیر)' },
  { command: 'sync', description: 'ارسال فوری صف کانال‌ها (مدیر)' },
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
    const ch = await db.get(sql`SELECT count(*) AS n FROM channels`);
    const al = await db.get(sql`SELECT count(*) AS n FROM album_items`);
    // How fast a database round trip is (album collection polls the DB).
    const t0 = Date.now();
    for (let i = 0; i < 10; i++) await db.get(sql`SELECT 1 AS x`);
    const dbRoundTripMs = (Date.now() - t0) / 10;
    return {
      ok: true,
      users: u.users, linked: u.linked || 0,
      codes: { pending: c.pending || 0, expired: c.expired || 0, used: c.used || 0 },
      baleOffset: s && s.update_offset,
      lockHeld: Boolean(s && s.lock_until > t),
      baleFailuresInRow: s && s.consecutive_failures,
      channels: ch.n, albumItemsWaiting: al.n, dbRoundTripMs,
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

  out.mirrorQueue = await step(async () => ({ ok: true, ...(await queueStats()) }));
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
    const consumed = await consumeCode(code);
    checks.consumeOnce = Boolean(consumed && consumed.tgId === fake && consumed.tgChannelId === null);
    checks.consumeTwice = (await consumeCode(code)) === null;
    const ch = await createChannelCode(fake, -1001);
    checks.channelCodeKind = (await consumeCode(ch.code)) === null
      && ((await consumeCode(ch.code, { channel: true })) || {}).tgChannelId === -1001;

    const plan = planMessage({ message_id: 7, text: 'x'.repeat(4500), entities: [{ type: 'bold', offset: 0, length: 3 }] });
    checks.planText = plan.ops.length === 2 && plan.ops[0].text.startsWith('*xxx*') && plan.layout[7] === 'text';
    const photo = (id) => ({ message_id: id, photo: [{ file_id: 'f' + id, file_unique_id: 'u' + id }] });
    const ap = planAlbum([{ tg: 9, spec: planMessage(photo(9)).ops[0].spec, caption: '' },
      { tg: 8, spec: planMessage(photo(8)).ops[0].spec, caption: 'c' }]);
    checks.planAlbum = ap.ops.length === 1 && ap.ops[0].op === 'group' && ap.ops[0].items[0].tg === 8
      && ap.ops[0].items[0].caption === 'c' && ap.fileUid[9] === 'u9';

    checks.claimFirst = (await claimMessage(fake, 1)) === true;
    checks.claimRepeat = (await claimMessage(fake, 1)) === false;

    await setLink(fake, 12345);
    checks.setLink = (await getUser(fake)).baleChatId === 12345;
    await clearLink(fake);
    checks.clearLink = (await getUser(fake)).baleChatId === null;

    checks.boldItalic = toBaleMarkdown('سلام دنیا خوب', [
      { type: 'bold', offset: 0, length: 5 }, { type: 'italic', offset: 5, length: 5 },
    ]) === '*سلام* _دنیا_ خوب';
    checks.nested = toBaleMarkdown('ab cd', [{ type: 'bold', offset: 0, length: 5 }, { type: 'italic', offset: 3, length: 2 }]) === '*ab _cd_*';
    checks.glued = toBaleMarkdown('abcd', [{ type: 'bold', offset: 1, length: 2 }]) === 'a *bc* d';
    const chunks = formatChunks('x'.repeat(10) + ' ' + 'y'.repeat(10), [{ type: 'bold', offset: 5, length: 12 }], 12);
    checks.chunkFormat = chunks.length === 2 && chunks[0].text === 'xxxxx *xxxxx*' && chunks[1].text === '*yyyyyy* yyyy'
      && chunks[1].plain === 'yyyyyyyyyy';

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
