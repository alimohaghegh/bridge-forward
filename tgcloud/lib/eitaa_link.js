// The main menu, help, and linking/managing Telegram channel → Eitaa
// mirrors (the Bale screens are in bale_ui.js).
//
// Linking: the user makes the bot admin of their Telegram channel (the
// my_chat_member update, or a forwarded post, tells us which), proves they
// are admin there (getChatMember), then picks a mode:
//  - simple: they make @sender and the operator managers of their Eitaa
//    channel and send its link; the bot owner registers it in EitaaYar and
//    replies to the request with the numeric id. Only that owner-approved id
//    is ever sent to (after a successful test post).
//  - advanced: they send their own EitaaYar token and channel id in one
//    message, which is deleted at once; after a test post the token is kept
//    encrypted.

import { api, db } from 'sdk';
import { eq, sql } from 'sdk/db';
import { users } from '../schema.js';
import { checkTelegramChannel, telegramChannelRef, getChannel } from './channels.js';
import { pickBaleChannel } from './bale_ui.js';
import { show, HOME_ROW } from './ui.js';
import {
  SHARED_TOKEN, OPERATOR_USERNAME, simpleModeEnabled, advancedModeEnabled, webCryptoAvailable,
  eitaaCall, classifyEitaa, describeFailure, encryptToken, eitaaReachable,
} from './eitaa.js';
import {
  getEitaaChannel, channelInfo, processQueue, retryChannel, sweepDeletions, queuedCount, recentPosts,
} from './eitaa_mirror.js';
import { isOwner } from './store.js';
import { OWNER_TELEGRAM_ID } from './config.js';
import { E, B, MENU } from './texts.js';
import { now, rowsOf, toAsciiDigits } from './util.js';

const STEP_SECONDS = 30 * 60;
const TOKEN_PATTERN = /\bbot\d+:[A-Za-z0-9-]{8,}\b/i;

async function pendingRequestCount() {
  const r = await db.get(sql`SELECT count(*) AS n FROM eitaa_requests WHERE status = 'pending'`);
  return Number(r && r.n) || 0;
}

// `note` (HTML) replaces the menu's invisible text, e.g. to explain why a
// message wasn't forwarded.
export async function showMenu(where, tgId, note) {
  const keyboard = [
    [{ text: MENU.bale, callback_data: 'm:bale' }],
    [{ text: MENU.baleChannels, callback_data: 'm:bch' }],
    [{ text: MENU.eitaa, callback_data: 'e:list' }],
    [{ text: MENU.help, callback_data: 'm:help' }],
  ];
  if (isOwner(tgId)) {
    const n = await pendingRequestCount();
    if (n) keyboard.push([{ text: MENU.requests(n), callback_data: 'e:reqs' }]);
  }
  await show(where, note || MENU.text, keyboard);
}

const homeRow = HOME_ROW;

export async function showHelp(where) {
  await show(where, E.help, [homeRow]);
}

// ── Pending steps (users.pending_step) ──────────────────────────────────────

async function setStep(tgId, step, tgChannelId) {
  await db.update(users)
    .set({ pendingStep: step, pendingTgChannel: tgChannelId || null, pendingUntil: now() + STEP_SECONDS })
    .where(eq(users.tgId, tgId))
    .run();
}

async function clearStep(tgId) {
  await db.update(users).set({ pendingStep: null, pendingTgChannel: null, pendingUntil: null }).where(eq(users.tgId, tgId)).run();
}

export function isEitaaStep(step) {
  return typeof step === 'string' && step.startsWith('e_');
}

// ── Step 1: the Telegram channel ────────────────────────────────────────────

export async function startLink(where, tgId) {
  if (!(await eitaaReachable())) {
    await show(where, E.unreachable + (isOwner(tgId) ? '\n\n' + E.unreachableOwner : ''), [homeRow]);
    return;
  }
  await setStep(tgId, 'e_admin');
  await show(where, E.start, [E.cancelRow]);
}

export async function cancelStep(where, tgId) {
  await clearStep(tgId);
  // A draft that never got a mode is just forgotten.
  await db.run(sql`DELETE FROM eitaa_channels WHERE owner_tg_id = ${tgId} AND status = 'draft'`);
  await show(where, E.cancelled, [homeRow]);
}

// Verifies the user may link `ref` (a channel id/@username) and shows the
// mode choice. `where` is where to answer.
export async function pickChannel(where, tgId, ref) {
  const tg = await checkTelegramChannel(ref, tgId);
  if (!tg.ok) {
    await show(where, tg.text, [E.cancelRow]);
    return false;
  }
  const existing = await getEitaaChannel(tg.id);
  if (existing && existing.ownerTgId === tgId && existing.status !== 'draft') {
    await clearStep(tgId);
    await show(where, E.alreadyLinked(tg.title), [[{ text: MENU.eitaa, callback_data: 'e:list' }], homeRow]);
    return false;
  }
  if (existing && existing.ownerTgId !== tgId && existing.status !== 'draft') {
    // Taken over only when the previous owner is no longer an admin there.
    const stillAdmin = await api.getChatMember({ chat_id: tg.id, user_id: existing.ownerTgId })
      .then((m) => m.status === 'creator' || m.status === 'administrator').catch(() => true);
    if (stillAdmin) {
      await clearStep(tgId);
      await show(where, E.takenByOther, [homeRow]);
      return false;
    }
    await removeMirror(tg.id);
  }
  await db.run(sql`
    INSERT INTO eitaa_channels (tg_channel_id, owner_tg_id, status, created_at)
    VALUES (${tg.id}, ${tgId}, 'draft', ${now()})
    ON CONFLICT (tg_channel_id) DO UPDATE SET owner_tg_id = excluded.owner_tg_id, status = 'draft', mode = NULL,
      eitaa_chat_id = NULL, token_enc = NULL`);
  await clearStep(tgId);
  await show(where, E.chooseMode(tg.title), [
    [{ text: E.btnSimple, callback_data: `e:ms:${tg.id}` }],
    [{ text: E.btnAdvanced, callback_data: `e:ma:${tg.id}` }],
    E.cancelRow,
  ]);
  return true;
}

// handlers/my_chat_member: the bot's status changed in a chat.
export async function onMyChatMember(u) {
  if (!u || !u.chat || u.chat.type !== 'channel' || !u.new_chat_member) return;
  const status = u.new_chat_member.status;
  const tgChannelId = u.chat.id;

  if (status === 'left' || status === 'kicked' || status === 'member') {
    const ch = await getEitaaChannel(tgChannelId);
    if (ch && ch.status === 'active') {
      await db.run(sql`UPDATE eitaa_channels SET status = 'stopped', stop_reason = 'bot_removed' WHERE tg_channel_id = ${tgChannelId}`);
      await api.sendMessage({ chat_id: ch.ownerTgId, text: E.botRemoved(u.chat.title || String(tgChannelId)), parse_mode: 'HTML' }).catch(() => null);
    }
    return;
  }
  if (status !== 'administrator' || !u.from || u.from.is_bot) return;

  const tgId = u.from.id;
  const user = await db.get(sql`SELECT pending_step, pending_until, blocked FROM users WHERE tg_id = ${tgId}`);
  if (!user || user.blocked) return; // never started the bot: can't message them
  const ch = await getEitaaChannel(tgChannelId);
  if (ch && ch.status === 'stopped' && ch.stopReason === 'bot_removed' && ch.ownerTgId === tgId) {
    await db.run(sql`UPDATE eitaa_channels SET status = 'active', stop_reason = NULL WHERE tg_channel_id = ${tgChannelId}`);
    await api.sendMessage({ chat_id: tgId, text: E.resumed }).catch(() => null);
    return;
  }
  const where = { chatId: tgId };
  const waiting = user.pending_until > now() ? user.pending_step : null;
  // In the middle of linking: continue it with this channel.
  if (waiting === 'e_admin') {
    await pickChannel(where, tgId, tgChannelId).catch(() => null);
    return;
  }
  if (waiting === 'tg_channel') {
    await pickBaleChannel(where, tgId, tgChannelId).catch(() => null);
    return;
  }
  // Otherwise ask where to (the DM may fail: then nothing happens).
  const toEitaa = !ch || ch.status === 'draft';
  const toBale = !(await getChannel(tgChannelId));
  const row = [];
  if (toBale) row.push({ text: B.btnToBale, callback_data: `m:bpick:${tgChannelId}` });
  if (toEitaa) row.push({ text: B.btnToEitaa, callback_data: `e:pick:${tgChannelId}` });
  if (row.length) await show(where, B.botAddedAsk(u.chat.title || String(tgChannelId)), [row]);
}

// ── Step 2: the mode ────────────────────────────────────────────────────────

async function draftOf(tgId, tgChannelId) {
  const ch = await getEitaaChannel(tgChannelId);
  return ch && ch.ownerTgId === tgId && (ch.status === 'draft' || ch.status === 'pending') ? ch : null;
}

export async function chooseSimple(where, tgId, tgChannelId) {
  if (!(await draftOf(tgId, tgChannelId))) return show(where, E.expired, [homeRow]);
  if (!simpleModeEnabled()) return show(where, E.simpleDisabled, [[{ text: E.btnAdvanced, callback_data: `e:ma:${tgChannelId}` }], E.cancelRow]);
  await setStep(tgId, 'e_link', tgChannelId);
  return show(where, E.simpleSteps(OPERATOR_USERNAME), [E.cancelRow]);
}

export async function chooseAdvanced(where, tgId, tgChannelId) {
  if (!(await draftOf(tgId, tgChannelId))) return show(where, E.expired, [homeRow]);
  if (!advancedModeEnabled()) return show(where, E.advancedDisabled, [[{ text: E.btnSimple, callback_data: `e:ms:${tgChannelId}` }], E.cancelRow]);
  await setStep(tgId, 'e_token', tgChannelId);
  return show(where, E.advancedSteps(webCryptoAvailable()), [E.cancelRow]);
}

// An Eitaa channel reference as typed by the user (only shown to the bot
// owner), or null.
function eitaaRefOf(text) {
  if (typeof text !== 'string') return null;
  const s = toAsciiDigits(text).trim();
  if (s.length > 200 || /\s/.test(s)) return null;
  if (/^(?:https?:\/\/)?(?:www\.)?eitaa\.(?:com|ir)\/\S+$/i.test(s)) return s;
  if (/^@?[A-Za-z][A-Za-z0-9_]{3,}$/.test(s)) return s.startsWith('@') ? s : '@' + s;
  if (/^-?\d{4,}$/.test(s)) return s;
  return null;
}

function displayName(from) {
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || '-';
  return from.username ? `${name} (@${from.username})` : name;
}

async function sendRequestToOwner(req, requester) {
  const info = await channelInfo(req.tgChannelId);
  try {
    const sent = await api.sendMessage({
      chat_id: OWNER_TELEGRAM_ID,
      text: E.ownerRequest({ ...req, requester, title: info.title }),
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: [[{ text: E.btnReject, callback_data: `e:rej:${req.id}` }]] },
    });
    await db.run(sql`UPDATE eitaa_requests SET owner_msg_id = ${sent.message_id} WHERE id = ${req.id}`);
  } catch {
    // The owner hasn't started the bot: the request waits in /requests.
  }
}

async function handleSimpleLink(message, user) {
  const tgId = message.from.id;
  const ref = eitaaRefOf(message.text);
  if (!ref) return show({ chatId: tgId }, E.simpleLinkBad, [E.cancelRow]);
  const tgChannelId = Number(user.pendingTgChannel);
  if (!(await draftOf(tgId, tgChannelId))) {
    await clearStep(tgId);
    return show({ chatId: tgId }, E.expired, [homeRow]);
  }
  const t = now();
  await db.run(sql`UPDATE eitaa_requests SET status = 'cancelled', decided_at = ${t} WHERE tg_channel_id = ${tgChannelId} AND status = 'pending'`);
  const ins = await db.run(sql`
    INSERT INTO eitaa_requests (tg_channel_id, requester_tg_id, eitaa_ref, status, created_at)
    VALUES (${tgChannelId}, ${tgId}, ${ref}, 'pending', ${t}) RETURNING id`);
  const id = Number(rowsOf(ins)[0].id);
  await db.run(sql`UPDATE eitaa_channels SET status = 'pending', mode = 'simple' WHERE tg_channel_id = ${tgChannelId}`);
  await clearStep(tgId);
  await sendRequestToOwner({ id, tgChannelId, requesterId: tgId, eitaaRef: ref }, displayName(message.from));
  return show({ chatId: tgId }, E.requestSaved, [[{ text: MENU.eitaa, callback_data: 'e:list' }], homeRow]);
}

// Pulls { token, chatId } out of the advanced-mode message.
function parseTokenMessage(text) {
  if (typeof text !== 'string') return null;
  const tokenMatch = text.match(TOKEN_PATTERN);
  const words = toAsciiDigits(text).split(/\s+/).filter(Boolean);
  const token = tokenMatch ? tokenMatch[0] : words.find((w) => w.includes(':') && w.length >= 20);
  if (!token) return null;
  let chatId = null;
  for (const w of words) {
    if (w === token || w.includes(token)) continue;
    const link = w.match(/^(?:https?:\/\/)?(?:www\.)?eitaa\.(?:com|ir)\/([A-Za-z0-9_]{4,})\/?$/i);
    if (/^-?\d{4,}$/.test(w)) chatId = w;
    else if (link) chatId = link[1];
    else if (/^@[A-Za-z][A-Za-z0-9_]{3,}$/.test(w)) chatId = w.slice(1);
    if (chatId) break;
  }
  return chatId ? { token, chatId } : null;
}

export function looksLikeEitaaToken(text) {
  return typeof text === 'string' && TOKEN_PATTERN.test(text);
}

async function handleToken(message, user) {
  const tgId = message.from.id;
  // The message holds a token: remove it before anything else.
  let deleted = true;
  await api.deleteMessage({ chat_id: message.chat.id, message_id: message.message_id }).catch(() => { deleted = false; });
  const warn = deleted ? '' : '\n\n' + E.tokenDeleteFailed;

  const parsed = parseTokenMessage(message.text);
  if (!parsed) return show({ chatId: tgId }, E.tokenBad + warn, [E.cancelRow]);
  const tgChannelId = Number(user.pendingTgChannel);
  if (!(await draftOf(tgId, tgChannelId))) {
    await clearStep(tgId);
    return show({ chatId: tgId }, E.expired + warn, [homeRow]);
  }

  await api.sendMessage({ chat_id: tgId, text: E.tokenChecking }).catch(() => null);
  const info = await channelInfo(tgChannelId);
  const r = await eitaaCall(parsed.token, 'sendMessage', { chat_id: parsed.chatId, text: E.testPost(info.title), title: 'tg-test' });
  if (!r.ok) {
    console.warn('eitaa advanced test failed:', describeFailure(r));
    return show({ chatId: tgId }, E.tokenFailed(E.reasonText(classifyEitaa(r))) + warn, [E.cancelRow]);
  }
  const tokenEnc = await encryptToken(parsed.token);
  await db.run(sql`
    UPDATE eitaa_channels SET mode = 'advanced', status = 'active', eitaa_chat_id = ${parsed.chatId},
      token_enc = ${tokenEnc}, linked_at = ${now()}, stop_reason = NULL, alerted = 0
    WHERE tg_channel_id = ${tgChannelId}`);
  await clearStep(tgId);
  return show({ chatId: tgId }, E.linkedAdvanced(info.title) + warn, [[{ text: MENU.eitaa, callback_data: 'e:list' }], homeRow]);
}

// A message while an Eitaa step is pending. Returns true when consumed.
export async function handleEitaaStep(step, message, user) {
  const tgId = message.from.id;
  if (step === 'e_admin') {
    const ref = telegramChannelRef(message);
    if (!ref) {
      await show({ chatId: tgId }, E.stepAdminBad, [E.cancelRow]);
      return true;
    }
    await pickChannel({ chatId: tgId }, tgId, ref);
    return true;
  }
  if (step === 'e_link') {
    await handleSimpleLink(message, user);
    return true;
  }
  if (step === 'e_token') {
    await handleToken(message, user);
    return true;
  }
  return false;
}

// ── The bot owner's side of simple mode ─────────────────────────────────────

// The owner replied to a request notification. Returns true when consumed.
export async function handleOwnerReply(message) {
  const reply = message.reply_to_message;
  if (!reply || !isOwner(message.from.id)) return false;
  const req = await db.get(sql`SELECT * FROM eitaa_requests WHERE owner_msg_id = ${reply.message_id}`);
  if (!req) return false;
  const chatId = message.chat.id;
  if (req.status !== 'pending') {
    await show({ chatId }, E.ownerRequestGone);
    return true;
  }
  const id = toAsciiDigits(String(message.text || '')).trim();
  if (!/^-?\d{3,}$/.test(id)) {
    await show({ chatId }, E.ownerNeedNumber);
    return true;
  }
  if (!SHARED_TOKEN) {
    await show({ chatId }, E.simpleDisabledOwner);
    return true;
  }
  const ch = await getEitaaChannel(Number(req.tg_channel_id));
  if (!ch || ch.status !== 'pending' || ch.ownerTgId !== Number(req.requester_tg_id)) {
    await db.run(sql`UPDATE eitaa_requests SET status = 'cancelled', decided_at = ${now()} WHERE id = ${req.id}`);
    await show({ chatId }, E.ownerRequestGone);
    return true;
  }

  await api.sendMessage({ chat_id: chatId, text: E.ownerTesting }).catch(() => null);
  const info = await channelInfo(ch.tgChannelId);
  const r = await eitaaCall(SHARED_TOKEN, 'sendMessage', { chat_id: id, text: E.testPost(info.title), title: 'tg-test' });
  if (!r.ok) {
    await show({ chatId }, E.ownerTestFailed(describeFailure(r)));
    return true;
  }
  const t = now();
  await db.run(sql`
    UPDATE eitaa_channels SET status = 'active', mode = 'simple', eitaa_chat_id = ${id}, linked_at = ${t},
      stop_reason = NULL, alerted = 0
    WHERE tg_channel_id = ${ch.tgChannelId}`);
  await db.run(sql`UPDATE eitaa_requests SET status = 'approved', decided_at = ${t} WHERE id = ${req.id}`);
  await api.editMessageReplyMarkup({ chat_id: chatId, message_id: reply.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => null);
  await show({ chatId: ch.ownerTgId }, E.linkedSimple(info.title), [[{ text: MENU.eitaa, callback_data: 'e:list' }]]);
  await show({ chatId }, E.ownerApproved(req.id));
  return true;
}

export async function rejectRequest(cq, requestId) {
  if (!isOwner(cq.from.id)) return;
  const req = await db.get(sql`SELECT * FROM eitaa_requests WHERE id = ${requestId}`);
  if (!req || req.status !== 'pending') {
    await show({ chatId: cq.from.id }, E.ownerRequestGone);
    return;
  }
  await db.run(sql`UPDATE eitaa_requests SET status = 'rejected', decided_at = ${now()} WHERE id = ${requestId}`);
  const tgChannelId = Number(req.tg_channel_id);
  const info = await channelInfo(tgChannelId);
  await db.run(sql`DELETE FROM eitaa_channels WHERE tg_channel_id = ${tgChannelId} AND status = 'pending' AND owner_tg_id = ${req.requester_tg_id}`);
  if (cq.message) {
    await api.editMessageReplyMarkup({ chat_id: cq.message.chat.id, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => null);
  }
  await show({ chatId: Number(req.requester_tg_id) }, E.requestRejected(info.title), [homeRow]);
  await show({ chatId: cq.from.id }, E.ownerRejected(requestId));
}

// Owner: re-sends every pending request (fresh messages to reply to).
export async function listRequests(chatId) {
  if (!simpleModeEnabled()) await show({ chatId }, E.simpleDisabledOwner);
  const rows = rowsOf(await db.all(sql`SELECT * FROM eitaa_requests WHERE status = 'pending' ORDER BY id LIMIT 10`));
  if (!rows.length) return show({ chatId }, E.ownerNoRequests);
  for (const r of rows) {
    let requester = String(r.requester_tg_id);
    try {
      const chat = await api.getChat({ chat_id: r.requester_tg_id });
      requester = displayName(chat);
    } catch {
      // Keep the id.
    }
    await sendRequestToOwner({
      id: Number(r.id), tgChannelId: Number(r.tg_channel_id), requesterId: Number(r.requester_tg_id), eitaaRef: r.eitaa_ref,
    }, requester);
  }
  return null;
}

// ── Channel lists («پل کانال به کانال») ──────────────────────────────────────────────────────────

export async function showList(where, tgId) {
  const rows = rowsOf(await db.all(sql`SELECT * FROM eitaa_channels WHERE owner_tg_id = ${tgId} ORDER BY created_at`));
  const keyboard = [];
  for (const r of rows) {
    const info = await channelInfo(Number(r.tg_channel_id));
    keyboard.push([{ text: `${E.status[r.status] || r.status} · ${info.title}`, callback_data: `e:ch:${r.tg_channel_id}` }]);
  }
  keyboard.push([{ text: MENU.addChannel, callback_data: 'e:new' }]);
  keyboard.push(homeRow);
  await show(where, rows.length ? E.listHeader : E.listEmpty, keyboard);
}

// The channel, if `tgId` may manage it (its owner, or the bot owner).
async function ownChannel(tgId, tgChannelId) {
  const ch = await getEitaaChannel(tgChannelId);
  if (!ch || (ch.ownerTgId !== tgId && !isOwner(tgId))) return null;
  return ch;
}

export async function showPanel(where, tgId, tgChannelId, note) {
  const ch = await ownChannel(tgId, tgChannelId);
  if (!ch) return show(where, E.notYours, [homeRow]);
  const info = await channelInfo(tgChannelId);
  const queued = await queuedCount(tgChannelId);
  const id = tgChannelId;
  const keyboard = [];
  if (ch.status === 'draft') {
    keyboard.push([{ text: E.btnSimple, callback_data: `e:ms:${id}` }], [{ text: E.btnAdvanced, callback_data: `e:ma:${id}` }]);
  }
  if (ch.status === 'active') keyboard.push([{ text: E.btnPause, callback_data: `e:pau:${id}` }, { text: E.btnSettings, callback_data: `e:set:${id}` }]);
  if (ch.status === 'paused' || ch.status === 'stopped') keyboard.push([{ text: E.btnResume, callback_data: `e:res:${id}` }, { text: E.btnSettings, callback_data: `e:set:${id}` }]);
  if (ch.status === 'active' || ch.status === 'paused' || ch.status === 'stopped') {
    keyboard.push([{ text: E.btnReport, callback_data: `e:rep:${id}` }, { text: E.btnCheckDeletes, callback_data: `e:del:${id}` }]);
    if (queued) keyboard.push([{ text: E.btnRetry, callback_data: `e:rt:${id}` }]);
  }
  keyboard.push([{ text: E.btnUnlink, callback_data: `e:unl:${id}` }]);
  keyboard.push([{ text: E.btnBack, callback_data: 'e:list' }]);
  return show(where, (note ? note + '\n\n' : '') + E.panel(info.title, ch, queued), keyboard);
}

export async function setPaused(where, tgId, tgChannelId, paused) {
  const ch = await ownChannel(tgId, tgChannelId);
  if (!ch) return show(where, E.notYours, [homeRow]);
  if (paused && ch.status === 'active') {
    await db.run(sql`UPDATE eitaa_channels SET status = 'paused' WHERE tg_channel_id = ${tgChannelId}`);
    return showPanel(where, tgId, tgChannelId, E.paused);
  }
  if (!paused && (ch.status === 'paused' || ch.status === 'stopped') && ch.mode && ch.eitaaChatId) {
    await db.run(sql`UPDATE eitaa_channels SET status = 'active', stop_reason = NULL, alerted = 0 WHERE tg_channel_id = ${tgChannelId}`);
    const r = await processQueue(tgChannelId, { deadline: Date.now() + 9000, waitMs: 2000 });
    return showPanel(where, tgId, tgChannelId, E.resumed + (r !== 'empty' ? '\n' + (E.retryResult[r] || '') : ''));
  }
  return showPanel(where, tgId, tgChannelId);
}

export async function showSettings(where, tgId, tgChannelId) {
  const ch = await ownChannel(tgId, tgChannelId);
  if (!ch) return show(where, E.notYours, [homeRow]);
  const id = tgChannelId;
  return show(where, E.settings(ch), [
    [{ text: E.btnAlbumSkip(ch.albumPolicy !== 'first'), callback_data: `e:alb:${id}:skip` }],
    [{ text: E.btnAlbumFirst(ch.albumPolicy === 'first'), callback_data: `e:alb:${id}:first` }],
    [{ text: E.btnNotify(ch.notifyEdits), callback_data: `e:ntf:${id}` }],
    [{ text: E.btnBack, callback_data: `e:ch:${id}` }],
  ]);
}

export async function setAlbumPolicy(where, tgId, tgChannelId, policy) {
  if (!(await ownChannel(tgId, tgChannelId))) return show(where, E.notYours, [homeRow]);
  await db.run(sql`UPDATE eitaa_channels SET album_policy = ${policy === 'first' ? 'first' : 'skip'} WHERE tg_channel_id = ${tgChannelId}`);
  return showSettings(where, tgId, tgChannelId);
}

export async function toggleNotify(where, tgId, tgChannelId) {
  if (!(await ownChannel(tgId, tgChannelId))) return show(where, E.notYours, [homeRow]);
  await db.run(sql`UPDATE eitaa_channels SET notify_edits = 1 - notify_edits WHERE tg_channel_id = ${tgChannelId}`);
  return showSettings(where, tgId, tgChannelId);
}

export async function showReport(where, tgId, tgChannelId) {
  if (!(await ownChannel(tgId, tgChannelId))) return show(where, E.notYours, [homeRow]);
  const info = await channelInfo(tgChannelId);
  const rows = await recentPosts(tgChannelId, 15);
  const lines = [E.reportHeader(info.title), ''];
  if (!rows.length) lines.push(E.reportEmpty);
  else lines.push(...rows.map(E.reportLine), '', E.reportFooter);
  return show(where, lines.join('\n'), [[{ text: E.btnBack, callback_data: `e:ch:${tgChannelId}` }]]);
}

export async function retryNow(where, tgId, tgChannelId) {
  if (!(await ownChannel(tgId, tgChannelId))) return show(where, E.notYours, [homeRow]);
  const r = await retryChannel(tgChannelId);
  return showPanel(where, tgId, tgChannelId, E.retryResult[r] || '');
}

export async function checkDeletions(where, tgId, tgChannelId) {
  if (!(await ownChannel(tgId, tgChannelId))) return show(where, E.notYours, [homeRow]);
  const n = await sweepDeletions(tgChannelId, { deadline: Date.now() + 12000, force: true });
  return showPanel(where, tgId, tgChannelId, E.checkResult(n));
}

export async function askUnlink(where, tgId, tgChannelId) {
  if (!(await ownChannel(tgId, tgChannelId))) return show(where, E.notYours, [homeRow]);
  const info = await channelInfo(tgChannelId);
  return show(where, E.unlinkAsk(info.title), [
    [{ text: E.btnUnlinkYes, callback_data: `e:unly:${tgChannelId}` }],
    [{ text: E.btnBack, callback_data: `e:ch:${tgChannelId}` }],
  ]);
}

async function removeMirror(tgChannelId) {
  await db.run(sql`UPDATE eitaa_requests SET status = 'cancelled', decided_at = ${now()} WHERE tg_channel_id = ${tgChannelId} AND status = 'pending'`);
  await db.run(sql`DELETE FROM eitaa_posts WHERE tg_channel_id = ${tgChannelId}`);
  await db.run(sql`DELETE FROM eitaa_albums WHERE tg_channel_id = ${tgChannelId}`);
  await db.run(sql`DELETE FROM eitaa_channels WHERE tg_channel_id = ${tgChannelId}`);
}

export async function unlink(where, tgId, tgChannelId) {
  if (!(await ownChannel(tgId, tgChannelId))) return show(where, E.notYours, [homeRow]);
  await removeMirror(tgChannelId);
  return show(where, E.unlinked, [[{ text: MENU.eitaa, callback_data: 'e:list' }], homeRow]);
}

// Counts for /stats (no ids).
export async function eitaaStats() {
  const c = await db.get(sql`
    SELECT count(*) AS total,
           sum(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
           sum(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
           sum(CASE WHEN status IN ('paused', 'stopped') THEN 1 ELSE 0 END) AS halted,
           sum(CASE WHEN mode = 'advanced' THEN 1 ELSE 0 END) AS advanced,
           coalesce(sum(sent_count), 0) AS sent, coalesce(sum(partial_count), 0) AS partial,
           coalesce(sum(failed_count), 0) AS failed
    FROM eitaa_channels WHERE status != 'draft'`);
  const q = await db.get(sql`SELECT count(*) AS n FROM eitaa_posts WHERE status = 'queued'`);
  return { ...c, queued: q.n, simpleEnabled: simpleModeEnabled(), advancedEnabled: advancedModeEnabled() };
}
