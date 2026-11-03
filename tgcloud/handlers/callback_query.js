// handlers/callback_query.js — the «verify» button: pull pending Bale
// messages, link any valid codes (for every user), and report back. Also
// the main menu (m:…), the Eitaa mirror screens (e:…) and the owner's
// /eitaa_diag answers (dg:…).

import { api } from 'sdk';
import { pollBale, notifyLinked, hasPendingCode, hasPendingChannelCode } from '../lib/linking.js';
import { touchUser, getUser, isOwner } from '../lib/store.js';
import { removeChannel } from '../lib/channels.js';
import { safeErrorText } from '../lib/bale.js';
import { T } from '../lib/texts.js';
import * as EL from '../lib/eitaa_link.js';
import { onFmtButton, onMethodButton } from '../lib/eitaa_diag.js';
import { runStartFlow } from '../lib/start.js';
import { onBaleFmtButton } from '../lib/bale_fmt.js';

async function answer(cq, text, showAlert) {
  try {
    await api.answerCallbackQuery({ callback_query_id: cq.id, text, show_alert: Boolean(showAlert) });
  } catch {
    // The query may have expired; nothing to do.
  }
}

// «قطع اتصال» buttons under /channels: callback data "unch:<tg channel id>".
async function unlinkChannel(cq) {
  try {
    const tgChannelId = Number(cq.data.slice(5));
    const removed = await removeChannel(tgChannelId, cq.from.id, isOwner(cq.from.id));
    await answer(cq, removed ? T.chUnlinked : T.chUnlinkNotFound, true);
    if (removed && cq.message) {
      const keyboard = ((cq.message.reply_markup && cq.message.reply_markup.inline_keyboard) || [])
        .filter((row) => !row.some((b) => b.callback_data === cq.data));
      await api.editMessageReplyMarkup({
        chat_id: cq.message.chat.id,
        message_id: cq.message.message_id,
        reply_markup: { inline_keyboard: keyboard },
      }).catch(() => null);
    }
  } catch (e) {
    console.error('channel unlink failed:', safeErrorText(e));
    await answer(cq, '⚠️ خطای غیرمنتظره‌ای رخ داد. لطفاً دوباره امتحان کنید.', true);
  }
}

// «کد را گذاشتم» under /channel step 2: look for the channel code in Bale.
async function verifyChannel(cq) {
  const tgId = cq.from.id;
  try {
    const result = await pollBale();
    await notifyLinked(result.linkedNow, tgId);
    if (result.channelLinked.has(tgId)) {
      // The outcome was sent as a message already.
      await answer(cq, T.chVerifyDone);
      if (!result.channelFailed.has(tgId) && cq.message) {
        await api.editMessageReplyMarkup({
          chat_id: cq.message.chat.id, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] },
        }).catch(() => null);
      }
      return;
    }
    if (result.status === 'busy') return answer(cq, T.verifyBusy, true);
    if (result.status === 'error') return answer(cq, T.verifyBaleDown, true);
    if (await hasPendingChannelCode(tgId)) return answer(cq, T.chVerifyNotFound, true);
    await answer(cq, T.chVerifyExpired, true);
  } catch (e) {
    console.error('channel verify failed:', safeErrorText(e));
    await answer(cq, '⚠️ خطای غیرمنتظره‌ای رخ داد. لطفاً دوباره امتحان کنید.', true);
  }
}

// m:… and e:… buttons. Returns true when handled.
async function menuButton(cq) {
  const data = cq.data;
  const tgId = cq.from.id;
  const where = { cq };
  const [ns, action, arg, arg2] = data.split(':');
  const ch = Number(arg);

  if (ns === 'bd') {
    if (isOwner(tgId)) await onBaleFmtButton(cq);
    return true;
  }
  if (ns === 'dg') {
    if (!isOwner(tgId)) return true;
    if (action === 'f' || action === 'fs') await onFmtButton(cq);
    else if (action === 'm') await onMethodButton(cq);
    return true;
  }
  if (ns === 'm') {
    if (action === 'home') await EL.showMenu(where, tgId);
    else if (action === 'help') await EL.showHelp(where);
    else if (action === 'bale') await runStartFlow(cq.message ? cq.message.chat.id : tgId, tgId);
    else if (action === 'bch') await EL.showBaleChannels(where, tgId);
    return true;
  }
  if (ns !== 'e') return false;
  switch (action) {
    case 'new': await EL.startLink(where, tgId); break;
    case 'cancel': await EL.cancelStep(where, tgId); break;
    case 'pick': await EL.pickChannel(where, tgId, ch); break;
    case 'ms': await EL.chooseSimple(where, tgId, ch); break;
    case 'ma': await EL.chooseAdvanced(where, tgId, ch); break;
    case 'list': await EL.showList(where, tgId); break;
    case 'ch': await EL.showPanel(where, tgId, ch); break;
    case 'pau': await EL.setPaused(where, tgId, ch, true); break;
    case 'res': await EL.setPaused(where, tgId, ch, false); break;
    case 'set': await EL.showSettings(where, tgId, ch); break;
    case 'alb': await EL.setAlbumPolicy(where, tgId, ch, arg2); break;
    case 'ntf': await EL.toggleNotify(where, tgId, ch); break;
    case 'rep': await EL.showReport(where, tgId, ch); break;
    case 'rt': await EL.retryNow(where, tgId, ch); break;
    case 'del': await EL.checkDeletions(where, tgId, ch); break;
    case 'unl': await EL.askUnlink(where, tgId, ch); break;
    case 'unly': await EL.unlink(where, tgId, ch); break;
    case 'rej': await EL.rejectRequest(cq, ch); break;
    case 'reqs': if (isOwner(tgId)) await EL.listRequests(tgId); break;
    default: break;
  }
  return true;
}

export default async function (cq) {
  if (!cq || !cq.from) return;
  if (typeof cq.data === 'string' && /^(m|e|dg|bd):/.test(cq.data)) {
    try {
      const user = await touchUser(cq.from.id);
      if (user.blocked && !isOwner(cq.from.id)) {
        await answer(cq, T.blocked, true);
        return;
      }
      // Answer first: some screens take a few seconds (retries, checks).
      await answer(cq);
      await menuButton(cq);
    } catch (e) {
      console.error('menu button failed:', e && e.name, safeErrorText(e));
      await api.sendMessage({ chat_id: cq.from.id, text: '⚠️ خطای غیرمنتظره‌ای رخ داد. لطفاً دوباره امتحان کنید.' }).catch(() => null);
    }
    return;
  }
  if (typeof cq.data === 'string' && cq.data.startsWith('unch:')) {
    await unlinkChannel(cq);
    return;
  }
  if (cq.data === 'verify_ch') {
    await verifyChannel(cq);
    return;
  }
  if (cq.data !== 'verify') {
    await answer(cq);
    return;
  }
  const tgId = cq.from.id;

  try {
    const user = await touchUser(tgId);
    if (user.blocked && !isOwner(tgId)) {
      await answer(cq, T.blocked, true);
      return;
    }

    const result = await pollBale();
    await notifyLinked(result.linkedNow, tgId);

    if (result.linkedNow.has(tgId)) {
      await answer(cq, '✅ اتصال برقرار شد');
      if (cq.message) {
        try {
          await api.editMessageReplyMarkup({
            chat_id: cq.message.chat.id,
            message_id: cq.message.message_id,
            reply_markup: { inline_keyboard: [] },
          });
        } catch {
          // Message too old or already edited.
        }
      }
      await api.sendMessage({ chat_id: tgId, text: T.verifySuccess }).catch(() => null);
      return;
    }

    if (result.status === 'busy') {
      await answer(cq, T.verifyBusy, true);
      return;
    }
    if (result.status === 'error') {
      await answer(cq, T.verifyBaleDown, true);
      return;
    }

    if (await hasPendingCode(tgId)) {
      await answer(cq, T.verifyNotFound, true);
      return;
    }
    const fresh = await getUser(tgId);
    if (fresh && fresh.baleChatId) {
      await answer(cq, T.verifyAlreadyLinked, true);
      return;
    }
    await answer(cq, T.verifyExpired, true);
  } catch (e) {
    console.error('callback handler failed:', safeErrorText(e));
    await answer(cq, '⚠️ خطای غیرمنتظره‌ای رخ داد. لطفاً دوباره امتحان کنید.', true);
  }
}
