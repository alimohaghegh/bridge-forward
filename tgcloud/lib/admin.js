// Owner-only commands: /stats, /users, /block, /unblock.

import { db } from 'sdk';
import { sql } from 'sdk/db';
import { getBaleState, setBlocked, isOwner } from './store.js';
import { formatDate, now } from './util.js';
import { eitaaStats } from './eitaa_link.js';

export const ADMIN_COMMANDS = new Set(['stats', 'users', 'block', 'unblock']);

async function stats() {
  const t = now();
  const u = await db.get(sql`
    SELECT count(*) AS total,
           sum(CASE WHEN bale_chat_id IS NOT NULL THEN 1 ELSE 0 END) AS linked,
           sum(CASE WHEN blocked = 1 THEN 1 ELSE 0 END) AS blocked,
           sum(CASE WHEN last_seen_at > ${t - 86400} THEN 1 ELSE 0 END) AS active_day,
           coalesce(sum(delivered_count), 0) AS delivered,
           coalesce(sum(failed_count), 0) AS failed
    FROM users`);
  const codes = await db.get(sql`SELECT count(*) AS c FROM codes WHERE used_at IS NULL AND expires_at > ${t}`);
  const state = await getBaleState();
  const e = await eitaaStats();
  return [
    '📊 <b>آمار ربات</b>',
    `👥 کاربران: ${u.total || 0}`,
    `🔗 متصل به بله: ${u.linked || 0}`,
    `⛔️ مسدود: ${u.blocked || 0}`,
    `🕐 فعال در ۲۴ ساعت گذشته: ${u.active_day || 0}`,
    `📨 پیام‌های رسیده: ${u.delivered}`,
    `⚠️ پیام‌های ناموفق: ${u.failed}`,
    `🔑 کدهای اتصال در انتظار: ${codes.c || 0}`,
    `🧭 خطاهای پیاپی بله: ${state.consecutiveFailures}`,
    '',
    '🪞 <b>ایتا</b>',
    `کانال‌ها: ${e.total || 0} (فعال ${e.active || 0} · در انتظار تأیید ${e.pending || 0} · متوقف ${e.halted || 0} · پیشرفته ${e.advanced || 0})`,
    `پست‌ها: کامل ${e.sent} · ناقص ${e.partial} · ناموفق ${e.failed} · در صف ${e.queued || 0}`,
    `حالت ساده: ${e.simpleEnabled ? 'فعال' : 'غیرفعال'} · حالت پیشرفته: ${e.advancedEnabled ? 'فعال' : 'غیرفعال'}`,
  ].join('\n');
}

async function listUsers() {
  const rows = await db.all(sql`
    SELECT tg_id, bale_chat_id, blocked, delivered_count, failed_count, last_seen_at
    FROM users ORDER BY last_seen_at DESC LIMIT 40`);
  if (!rows.length) return 'هنوز کاربری وجود ندارد.';
  const lines = rows.map((r) =>
    `<code>${r.tg_id}</code> ${r.bale_chat_id ? '🔗' : '➖'}${r.blocked ? ' ⛔️' : ''} ` +
    `✅${r.delivered_count} ❌${r.failed_count} · ${formatDate(r.last_seen_at)}`
  );
  return ['👥 <b>آخرین کاربران</b> (🔗 متصل، ⛔️ مسدود):', '', ...lines].join('\n');
}

async function block(arg, value) {
  const id = Number(String(arg || '').trim());
  if (!Number.isSafeInteger(id) || id <= 0) {
    return `استفاده: /${value ? 'block' : 'unblock'} &lt;telegram_id&gt;`;
  }
  if (value && isOwner(id)) return 'نمی‌توانید خودتان را مسدود کنید.';
  await setBlocked(id, value);
  return value ? `⛔️ کاربر <code>${id}</code> مسدود شد.` : `✅ کاربر <code>${id}</code> از حالت مسدود خارج شد.`;
}

// Returns the HTML reply for an owner command.
export async function runAdminCommand(command, arg) {
  if (command === 'stats') return stats();
  if (command === 'users') return listUsers();
  if (command === 'block') return block(arg, true);
  if (command === 'unblock') return block(arg, false);
  return null;
}
