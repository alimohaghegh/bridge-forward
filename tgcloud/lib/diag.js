// Bale connectivity probe, for the owner's /diag command and CI
// (`npx tgcloud run handlers/message '{ __diag: true }'`).
// Reports per-attempt outcome and timing only: no tokens, ids or contents.

import { api, db } from 'sdk';
import { sql } from 'sdk/db';
import { baleCallOnce, safeErrorText } from './bale.js';
import { OWNER_TELEGRAM_ID } from './config.js';
import { getUser } from './store.js';
import { enqueuePost, enqueueEdit, drain } from './mirror.js';
import { saveChannel } from './channels.js';

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
