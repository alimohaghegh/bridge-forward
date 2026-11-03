// Telegram channel → Bale channel mirrors: setup checks and storage.
//
// Setup («پل کانال به کانال (به بله)», or /channel) is two steps in the
// private chat: the user names their Telegram channel (the bot was made
// admin, a forwarded post, @username or id), then their Bale chat — its
// @username (public), a post of it forwarded to the Bale bot (private
// channel), or a code posted in it (group). Nothing else is posted there. The bot must be admin in both, and
// the user must be admin of both (on Bale, via their linked Bale account).

import { api, db, BotApiError } from 'sdk';
import { eq, sql } from 'sdk/db';
import { channels, users } from '../schema.js';
import { baleCall, classifyError } from './bale.js';
import { now } from './util.js';
import { T, MENU } from './texts.js';

const PENDING_SECONDS = 10 * 60;

// ── Storage ─────────────────────────────────────────────────────────────────

export async function getChannel(tgChannelId) {
  return db.select().from(channels).where(eq(channels.tgChannelId, tgChannelId)).get();
}

export async function listChannels(ownerTgId) {
  return db.select().from(channels).where(eq(channels.ownerTgId, ownerTgId)).all();
}

export async function saveChannel(tgChannelId, baleChatId, ownerTgId) {
  const t = now();
  await db.insert(channels)
    .values({ tgChannelId, baleChatId, ownerTgId, linkedAt: t })
    .onConflictDoUpdate({ target: channels.tgChannelId, set: { baleChatId, ownerTgId, linkedAt: t } })
    .run();
}

// Removes a mirror if `tgId` set it up (or `force`, for the bot owner).
export async function removeChannel(tgChannelId, tgId, force) {
  const r = force
    ? await db.run(sql`DELETE FROM channels WHERE tg_channel_id = ${tgChannelId}`)
    : await db.run(sql`DELETE FROM channels WHERE tg_channel_id = ${tgChannelId} AND owner_tg_id = ${tgId}`);
  return r.rowsAffected > 0;
}

export async function countChannelDelivery(tgChannelId, ok) {
  if (ok) {
    await db.run(sql`UPDATE channels SET delivered_count = delivered_count + 1 WHERE tg_channel_id = ${tgChannelId}`);
  } else {
    await db.run(sql`UPDATE channels SET failed_count = failed_count + 1 WHERE tg_channel_id = ${tgChannelId}`);
  }
}

export async function setPending(tgId, step, tgChannelId) {
  await db.update(users)
    .set({ pendingStep: step, pendingTgChannel: tgChannelId || null, pendingUntil: now() + PENDING_SECONDS })
    .where(eq(users.tgId, tgId))
    .run();
}

export async function clearPending(tgId) {
  await db.update(users)
    .set({ pendingStep: null, pendingTgChannel: null, pendingUntil: null })
    .where(eq(users.tgId, tgId))
    .run();
}

export function activePending(user) {
  return user && user.pendingStep && user.pendingUntil > now() ? user.pendingStep : null;
}

// Channel title for display (looked up live; titles aren't stored).
export async function telegramChannelTitle(tgChannelId) {
  try {
    const chat = await api.getChat({ chat_id: tgChannelId });
    return chat.title || String(tgChannelId);
  } catch {
    return String(tgChannelId);
  }
}

// ── Step 1: the Telegram channel ────────────────────────────────────────────

// The channel a message points at: a forwarded channel post, or text with
// @username, a t.me link or a numeric id. Returns a chat_id or null.
export function telegramChannelRef(m) {
  const o = m.forward_origin;
  if (o && o.type === 'channel' && o.chat) return o.chat.id;
  if (m.forward_from_chat && m.forward_from_chat.type === 'channel') return m.forward_from_chat.id;
  return parseRef(m.text, /^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/([A-Za-z0-9_]{4,})\/?$/i);
}

function parseRef(text, linkPattern) {
  if (typeof text !== 'string') return null;
  const s = text.trim();
  const link = s.match(linkPattern);
  if (link) return '@' + link[1];
  if (/^@[A-Za-z0-9_]{3,}$/.test(s)) return s;
  if (/^-?\d{5,}$/.test(s)) return Number(s);
  return null;
}

function isAdmin(member) {
  return member && (member.status === 'creator' || member.status === 'administrator');
}

// Returns { ok: true, id, title } or { ok: false, text }.
export async function checkTelegramChannel(ref, tgId) {
  let chat;
  try {
    chat = await api.getChat({ chat_id: ref });
  } catch {
    return { ok: false, text: T.chTgNotFound };
  }
  if (chat.type !== 'channel') return { ok: false, text: T.chTgNotChannel };
  try {
    const me = await api.getMe();
    const bot = await api.getChatMember({ chat_id: chat.id, user_id: me.id });
    if (bot.status !== 'administrator') return { ok: false, text: T.chTgBotNotAdmin };
    const member = await api.getChatMember({ chat_id: chat.id, user_id: tgId });
    if (!isAdmin(member)) return { ok: false, text: T.chTgUserNotAdmin };
  } catch (e) {
    if (e instanceof BotApiError) return { ok: false, text: T.chTgBotNotAdmin };
    throw e;
  }
  return { ok: true, id: chat.id, title: chat.title || String(chat.id) };
}

// ── Step 2: the Bale channel ────────────────────────────────────────────────

export function baleChannelRef(text) {
  return parseRef(text, /^(?:https?:\/\/)?(?:web\.)?(?:ble\.ir|bale\.ai)\/([A-Za-z0-9_]{3,})\/?$/i);
}

// Checks a public Bale channel given by @username / id. Returns { ok: true,
// id, title } or { ok: false, text }. The owner of the bot skips the "you
// are admin" check (only the bot's rights are checked).
export async function checkBaleChannel(ref, userBaleId, skipUserCheck) {
  const chat = await baleCall('getChat', { chat_id: ref });
  if (!chat.ok) {
    const reason = classifyError(chat);
    return { ok: false, text: reason === 'unavailable' ? T.chBaleDown : T.chBaleNotFound };
  }
  const info = chat.result || {};
  if (!info.id) return { ok: false, text: T.chBaleNotFound };

  const admins = await baleCall('getChatAdministrators', { chat_id: info.id });
  if (!admins.ok) {
    const reason = classifyError(admins);
    return { ok: false, text: reason === 'unavailable' ? T.chBaleDown : T.chBaleBotNotAdmin };
  }
  const list = Array.isArray(admins.result) ? admins.result : [];
  const me = await baleCall('getMe', {});
  if (me.ok && me.result) {
    const bot = list.find((a) => a.user && a.user.id === me.result.id);
    if (!bot) return { ok: false, text: T.chBaleBotNotAdmin };
    if (bot.can_post_messages === false) return { ok: false, text: T.chBaleBotCantPost };
  }
  if (!skipUserCheck && !list.some((a) => a.user && Number(a.user.id) === Number(userBaleId))) {
    return { ok: false, text: T.chBaleUserNotAdmin };
  }
  if (info.type && info.type !== 'channel' && info.type !== 'group') return { ok: false, text: T.chBaleNotChannel };
  // Rights come from the admin list only: nothing is posted in the chat to
  // test them (it may be a public channel).
  const bot = me.ok && me.result ? list.find((a) => a.user && a.user.id === me.result.id) : null;
  return { ok: true, id: info.id, title: info.title || String(info.id), canDelete: !(bot && bot.can_delete_messages === false) };
}

// Finishes linking once the Bale chat is known: from a post of it forwarded
// to the Bale bot (`userBaleId` set: that user must be its admin), or from a
// code posted in it. `target`: { chatId, type, title, userBaleId?,
// posterId?, codeMessageId? }. Tells the user the outcome in Telegram.
// Returns { ok }.
export async function linkBaleTarget(tgId, tgChannelId, target) {
  const tell = (text, keyboard) => api.sendMessage({
    chat_id: tgId, text, parse_mode: 'HTML', ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
  }).catch(() => null);

  const tg = await checkTelegramChannel(tgChannelId, tgId);
  if (!tg.ok) {
    await tell(tg.text);
    return { ok: false };
  }

  // In a group, whoever posted the code must be an admin there.
  if (target.type === 'group' && target.posterId) {
    const member = await baleCall('getChatMember', { chat_id: target.chatId, user_id: target.posterId });
    if (!member.ok) {
      await tell(classifyError(member) === 'unavailable' ? T.chBaleDown : T.chBaleGroupBotNotAdmin);
      return { ok: false };
    }
    if (!isAdmin(member.result)) {
      await tell(T.chBaleGroupPosterNotAdmin);
      return { ok: false };
    }
  }

  const bale = await checkBaleChannel(target.chatId, target.userBaleId, !target.userBaleId);
  if (!bale.ok) {
    await tell(bale.text);
    return { ok: false };
  }

  await saveChannel(tg.id, bale.id, tgId);
  await clearPending(tgId);
  if (target.codeMessageId) {
    await baleCall('deleteMessage', { chat_id: target.chatId, message_id: target.codeMessageId });
  }
  const title = bale.title || target.title || (target.type === 'group' ? 'گروه بله' : 'کانال بله');
  await tell(T.chLinked(tg.title, title) + (bale.canDelete ? '' : '\n\n' + T.chCantDelete), [
    [{ text: MENU.baleChannels, callback_data: 'm:bch' }], [{ text: MENU.home, callback_data: 'm:home' }],
  ]);
  return { ok: true };
}
