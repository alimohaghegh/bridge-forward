// handlers/callback_query.js — the «verify» button: pull pending Bale
// messages, link any valid codes (for every user), and report back.

import { api } from 'sdk';
import { pollBale, notifyLinked, hasPendingCode } from '../lib/linking.js';
import { touchUser, getUser, isOwner } from '../lib/store.js';
import { safeErrorText } from '../lib/bale.js';
import { T } from '../lib/texts.js';

async function answer(cq, text, showAlert) {
  try {
    await api.answerCallbackQuery({ callback_query_id: cq.id, text, show_alert: Boolean(showAlert) });
  } catch {
    // The query may have expired; nothing to do.
  }
}

export default async function (cq) {
  if (!cq || !cq.from) return;
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
