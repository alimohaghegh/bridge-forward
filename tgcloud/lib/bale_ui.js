// Telegram screens for the two Bale bridges, driven by buttons:
//  - «پل بات به بات (به بله)»: the user's own Bale chat (linking code,
//    test message, unlinking);
//  - «پل کانال به کانال (به بله)»: Telegram channel → Bale channel/group in
//    two steps (the Telegram channel — found automatically when the bot is
//    made admin, or from a forwarded post — then a code posted in Bale).

import { api } from 'sdk';
import { baleCall, classifyError, isSystemError } from './bale.js';
import {
  listChannels, telegramChannelTitle, setPending, clearPending, checkTelegramChannel, telegramChannelRef,
  baleChannelRef, checkBaleChannel, confirmBaleTarget, saveChannel,
} from './channels.js';
import { createCode, getOrCreateCode, deletePendingCodes, createChannelCode } from './linking.js';
import { getUser, clearLink, isOwner, recordBaleSuccess, recordBaleFailure } from './store.js';
import { show, HOME_ROW } from './ui.js';
import {
  T, B, E, MENU, linkInstructions, statusText, baleStartLink, VERIFY_BUTTON, OPEN_BALE_BUTTON, VERIFY_CHANNEL_BUTTON,
} from './texts.js';

const CANCEL_ROW = E.cancelRow;

// ── «پل بات به بات» ─────────────────────────────────────────────────────────

export async function sendLinkInstructions(chatId, tgId, { fresh, prefix } = {}) {
  const { code, minutesLeft } = fresh ? await createCode(tgId) : await getOrCreateCode(tgId);
  const text = (prefix ? prefix + '\n\n' : '') + linkInstructions(code, minutesLeft);
  await show({ chatId }, text, [
    [{ text: OPEN_BALE_BUTTON, url: baleStartLink(code) }],
    [{ text: VERIFY_BUTTON, callback_data: 'verify' }],
    HOME_ROW,
  ]);
}

// The bridge's screen: the link's status and actions, or the linking steps.
export async function showAccount(where, tgId) {
  const user = await getUser(tgId);
  if (!user || !user.baleChatId) {
    await sendLinkInstructions(where.chatId || where.cq.from.id, tgId);
    return;
  }
  await show(where, statusText(user), [
    [{ text: B.btnTest, callback_data: 'm:btest' }],
    [{ text: B.btnConnectChannel, callback_data: 'm:bnew' }],
    [{ text: B.btnUnlinkAccount, callback_data: 'm:bunl' }],
    HOME_ROW,
  ]);
}

// Right after the Bale account got linked.
export async function showLinked(chatId) {
  await show({ chatId }, T.verifySuccess, [
    [{ text: B.btnConnectChannel, callback_data: 'm:bnew' }],
    [{ text: B.btnTest, callback_data: 'm:btest' }],
    HOME_ROW,
  ]);
}

export async function sendTest(where, tgId) {
  const user = await getUser(tgId);
  if (!user || !user.baleChatId) return showAccount(where, tgId);
  const r = await baleCall('sendMessage', { chat_id: user.baleChatId, text: T.baleTest });
  let text = T.testOk;
  if (r.ok) {
    await recordBaleSuccess();
  } else {
    const reason = classifyError(r);
    if (isSystemError(reason)) await recordBaleFailure('test/' + reason);
    text = T.fail[reason] || T.fail.rejected;
  }
  return show(where, text, [[{ text: MENU.bale, callback_data: 'm:bale' }], HOME_ROW]);
}

export async function askUnlinkAccount(where) {
  return show(where, B.unlinkAsk, [[{ text: B.btnUnlinkYes, callback_data: 'm:bunly' }], [{ text: E.btnBack, callback_data: 'm:bale' }]]);
}

export async function unlinkAccount(where, tgId) {
  const user = await getUser(tgId);
  if (!user || !user.baleChatId) return show(where, T.notLinkedForUnlink, [HOME_ROW]);
  await clearLink(tgId);
  await deletePendingCodes(tgId);
  await baleCall('sendMessage', { chat_id: user.baleChatId, text: T.baleUnlinked });
  return show(where, T.unlinked, [HOME_ROW]);
}

// ── «پل کانال به کانال (به بله)» ────────────────────────────────────────────

// The linked channels with their unlink buttons, and «اتصال کانال جدید».
export async function showBaleChannels(where, tgId) {
  const list = await listChannels(tgId);
  const keyboard = [];
  for (const ch of list) {
    const title = await telegramChannelTitle(ch.tgChannelId);
    keyboard.push([{ text: T.chUnlinkButton(title), callback_data: `unch:${ch.tgChannelId}` }]);
  }
  keyboard.push([{ text: MENU.addChannel, callback_data: 'm:bnew' }]);
  keyboard.push(HOME_ROW);
  return show(where, list.length ? E.baleListHeader : E.baleListEmpty, keyboard);
}

async function needsAccount(where, tgId) {
  const user = await getUser(tgId);
  if (user && user.baleChatId) return false;
  await show(where, E.baleNeedAccount, [[{ text: MENU.bale, callback_data: 'm:bale' }], HOME_ROW]);
  return true;
}

// «➕ اتصال کانال جدید»: step 1 waits for the Telegram channel.
export async function startBaleChannel(where, tgId) {
  if (await needsAccount(where, tgId)) return;
  await setPending(tgId, 'tg_channel');
  await show(where, T.chStep1, [CANCEL_ROW]);
}

// Step 1 done (forwarded post, @username, or the bot was just made admin):
// checks both admins and shows step 2 with a fresh code.
export async function pickBaleChannel(where, tgId, ref) {
  if (await needsAccount(where, tgId)) return;
  const tg = await checkTelegramChannel(ref, tgId);
  if (!tg.ok) {
    await show(where, tg.text, [CANCEL_ROW]);
    return;
  }
  await setPending(tgId, 'bale_channel', tg.id);
  const { code } = await createChannelCode(tgId, tg.id);
  await show(where, T.chStep2(tg.title, code), [[{ text: VERIFY_CHANNEL_BUTTON, callback_data: 'verify_ch' }], CANCEL_ROW]);
}

export function linkedButtons() {
  return [[{ text: MENU.baleChannels, callback_data: 'm:bch' }], HOME_ROW];
}

// A message while a Bale channel step is pending. Returns true when consumed.
export async function handleBaleStep(step, message, user) {
  const chatId = message.chat.id;
  const tgId = message.from.id;
  const where = { chatId };

  if (step === 'tg_channel') {
    const ref = telegramChannelRef(message);
    if (!ref) {
      await show(where, T.chStep1Bad, [CANCEL_ROW]);
      return true;
    }
    await pickBaleChannel(where, tgId, ref);
    return true;
  }

  if (step === 'bale_channel') {
    const ref = baleChannelRef(message.text);
    if (!ref) {
      await show(where, T.chStep2Bad, [CANCEL_ROW]);
      return true;
    }
    await show(where, T.chChecking);
    // Re-check the Telegram side: rights may have changed meanwhile.
    const tg = await checkTelegramChannel(user.pendingTgChannel, tgId);
    if (!tg.ok) {
      await clearPending(tgId);
      await show(where, tg.text, [[{ text: MENU.addChannel, callback_data: 'm:bnew' }], HOME_ROW]);
      return true;
    }
    const bale = await checkBaleChannel(ref, user.baleChatId, isOwner(tgId));
    if (!bale.ok) {
      await show(where, bale.text, [CANCEL_ROW]);
      return true;
    }
    const confirm = await confirmBaleTarget(bale.id);
    if (!confirm.ok) {
      await show(where, confirm.text, [CANCEL_ROW]);
      return true;
    }
    await saveChannel(tg.id, bale.id, tgId);
    await clearPending(tgId);
    await deletePendingCodes(tgId);
    await show(where, T.chLinked(tg.title, bale.title) + (confirm.canDelete ? '' : '\n\n' + T.chCantDelete), linkedButtons());
    return true;
  }
  return false;
}
