// Bale connectivity probe, for the owner's /diag command and CI
// (`npx tgcloud run handlers/message '{ __diag: true }'`).
// Reports per-attempt outcome and timing only: no tokens, ids or contents.

import { api, db } from 'sdk';
import { sql } from 'sdk/db';
import { baleCallOnce, safeErrorText } from './bale.js';
import { OWNER_TELEGRAM_ID } from './config.js';
import { getUser } from './store.js';

const BUDGET_MS = 22000;

function summarize(r, ms) {
  const out = { ok: r.ok === true, ms };
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
  const line = (r) => (r.ok ? `✅ ${r.ms}ms` : `❌ ${r.ms}ms code=${r.code}${r.network ? ' network' : ''} ${r.desc || ''}`);
  return [
    '🔧 بررسی اتصال به بله',
    `chat id: ${report.chatIdType}`,
    'getMe:', ...report.getMe.map(line),
    'sendMessage:', ...(report.sendMessage.length ? report.sendMessage.map(line) : ['—']),
    `total: ${report.totalMs}ms`,
  ].join('\n');
}

// Can deleted channel posts be detected? editMessageReplyMarkup without a
// markup on a post that has none: "not modified" = exists, "not found" = gone.
export async function runDeleteProbe() {
  const ch = await db.get(sql`SELECT tg_channel_id AS id FROM channels LIMIT 1`);
  if (!ch) return { ok: false, error: 'no channel' };
  const last = await db.get(sql`SELECT max(message_id) AS mid FROM delivered WHERE chat_id = ${ch.id}`);
  const out = {};
  const me = await api.getMe();
  const bot = await api.getChatMember({ chat_id: ch.id, user_id: me.id }).catch(() => null);
  out.botRights = bot && { status: bot.status, edit: bot.can_edit_messages, del: bot.can_delete_messages, post: bot.can_post_messages };
  for (const [name, mid] of [['existing', last && last.mid], ['missing', ((last && last.mid) || 1) + 100000]]) {
    try {
      await api.editMessageReplyMarkup({ chat_id: ch.id, message_id: mid });
      out[name] = 'ok';
    } catch (e) {
      out[name] = `${e.code}: ${e.description}`;
    }
  }
  return out;
}
