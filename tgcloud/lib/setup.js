// Deploy-time setup and smoke check, run from CI with
//   npx tgcloud run handlers/message '{ __setup: true }'
// It clears Bale's webhook (getUpdates needs that), registers the Telegram
// command menu and reports what works. The result contains no secrets.

import { api, db } from 'sdk';
import { sql } from 'sdk/db';
import { baleCall } from './bale.js';
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
    return { ok: false, error: (e && (e.description || e.name)) || 'error' };
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

  out.baleGetMe = await step(async () => {
    const r = await baleCall('getMe', {});
    return r.ok ? { ok: true, username: r.result && r.result.username } : { ok: false, code: r.error_code, description: r.description };
  });

  out.baleDeleteWebhook = await step(async () => {
    const r = await baleCall('deleteWebhook', {});
    return { ok: r.ok, code: r.error_code };
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

  out.database = await step(async () => {
    const u = await db.get(sql`SELECT count(*) AS c FROM users`);
    const s = await db.get(sql`SELECT count(*) AS c FROM bale_state`);
    return { ok: true, users: u.c, stateRows: s.c };
  });

  out.selfTest = await step(selfTest);

  return out;
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
    await db.run(sql`DELETE FROM link_codes WHERE tg_id = ${fake}`);
    await db.run(sql`DELETE FROM delivered WHERE chat_id = ${fake}`);
  }
  return { ok: Object.values(checks).every(Boolean), checks };
}
