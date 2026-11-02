// handlers/message.js — every private message: commands, linking prompts and
// forwarding to the user's Bale chat. Message contents are never stored or logged.

import { api } from 'sdk';
import { baleCall, classifyError, isSystemError, safeErrorText } from '../lib/bale.js';
import { deliver, isSupported } from '../lib/forward.js';
import {
  createCode, getOrCreateCode, deletePendingCodes, hasPendingCode, pollBale, notifyLinked,
} from '../lib/linking.js';
import { ADMIN_COMMANDS, runAdminCommand } from '../lib/admin.js';
import { runSetup } from '../lib/setup.js';
import {
  touchUser, getUser, clearLink, claimMessage, maybeCleanup, countDelivery, isOwner,
  recordBaleSuccess, recordBaleFailure,
} from '../lib/store.js';
import { T, linkInstructions, statusText, baleStartLink, VERIFY_BUTTON, OPEN_BALE_BUTTON } from '../lib/texts.js';
import { TELEGRAM_BOT_USERNAME } from '../lib/util.js';

async function reply(chatId, text, extra) {
  try {
    await api.sendMessage({ chat_id: chatId, text, link_preview_options: { is_disabled: true }, ...extra });
  } catch (e) {
    console.warn('reply failed', e && e.code);
  }
}

async function replyHtml(chatId, text, extra) {
  await reply(chatId, text, { parse_mode: 'HTML', ...extra });
}

async function sendLinkInstructions(chatId, tgId, { fresh, prefix } = {}) {
  const { code, minutesLeft } = fresh ? await createCode(tgId) : await getOrCreateCode(tgId);
  const text = (prefix ? prefix + '\n\n' : '') + linkInstructions(code, minutesLeft);
  await replyHtml(chatId, text, {
    reply_markup: {
      inline_keyboard: [
        [{ text: OPEN_BALE_BUTTON, url: baleStartLink(code) }],
        [{ text: VERIFY_BUTTON, callback_data: 'verify' }],
      ],
    },
  });
}

function parseCommand(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(/^\/([A-Za-z0-9_]+)(?:@(\S+))?(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  if (m[2] && m[2].toLowerCase() !== TELEGRAM_BOT_USERNAME) return null;
  return { name: m[1].toLowerCase(), arg: (m[3] || '').trim() };
}

// Returns true when the command was handled; unknown commands are forwarded.
async function handleCommand(cmd, chatId, tgId, user) {
  switch (cmd.name) {
    case 'start':
      if (user.baleChatId) {
        await reply(chatId, statusText(user) + '\n\nراهنما: /help');
      } else {
        await sendLinkInstructions(chatId, tgId);
      }
      return true;

    case 'link':
      await sendLinkInstructions(chatId, tgId, {
        fresh: true,
        prefix: user.baleChatId
          ? 'ℹ️ حساب بله شما الان متصل است. اگر با این کد حساب بله دیگری را وصل کنید، جایگزین قبلی می‌شود.'
          : '',
      });
      return true;

    case 'unlink':
      if (!user.baleChatId) {
        await reply(chatId, T.notLinkedForUnlink);
        return true;
      }
      await clearLink(tgId);
      await deletePendingCodes(tgId);
      await baleCall('sendMessage', { chat_id: user.baleChatId, text: T.baleUnlinked });
      await reply(chatId, T.unlinked);
      return true;

    case 'status':
      await reply(chatId, statusText(user));
      return true;

    case 'help':
      await replyHtml(chatId, T.help);
      return true;

    case 'test': {
      if (!user.baleChatId) {
        await sendLinkInstructions(chatId, tgId, { prefix: '🔌 هنوز حساب بله‌ای متصل نیست.' });
        return true;
      }
      const r = await baleCall('sendMessage', { chat_id: user.baleChatId, text: T.baleTest });
      if (r.ok) {
        await recordBaleSuccess();
        await reply(chatId, T.testOk);
      } else {
        const reason = classifyError(r);
        if (isSystemError(reason)) await recordBaleFailure('test/' + reason);
        await reply(chatId, T.fail[reason] || T.fail.rejected);
      }
      return true;
    }
  }

  if (ADMIN_COMMANDS.has(cmd.name) && isOwner(tgId)) {
    await replyHtml(chatId, await runAdminCommand(cmd.name, cmd.arg));
    return true;
  }
  return false;
}

async function forward(message, user) {
  const chatId = message.chat.id;
  const tgId = message.from.id;

  if (!isSupported(message)) {
    await reply(chatId, T.unsupported, { reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true } });
    return;
  }

  const result = await deliver(user.baleChatId, message);
  await countDelivery(tgId, result.ok);

  if (result.ok) {
    await recordBaleSuccess();
    try {
      await api.setMessageReaction({
        chat_id: chatId,
        message_id: message.message_id,
        reaction: [{ type: 'emoji', emoji: '👍' }],
      });
    } catch {
      // Reactions are a nicety; ignore failures.
    }
    return;
  }

  if (isSystemError(result.reason)) await recordBaleFailure('send/' + result.reason);
  await reply(chatId, T.fail[result.reason] || T.fail.rejected, {
    reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
  });
}

export default async function (message, ctx) {
  // Deploy-time setup, reachable only through `tgcloud run` (real updates
  // always carry ctx.update and never this field).
  if (!(ctx && ctx.update) && message && message.__setup === true) return runSetup();

  if (!message || !message.chat || message.chat.type !== 'private' || !message.from || message.from.is_bot) return;
  const chatId = message.chat.id;
  const tgId = message.from.id;

  try {
    if (!(await claimMessage(chatId, message.message_id))) return; // redelivery
    await maybeCleanup();

    let user = await touchUser(tgId);
    if (user.blocked && !isOwner(tgId)) {
      await reply(chatId, T.blocked);
      return;
    }

    const cmd = parseCommand(message.text);

    // An unlinked user with a pending code may already have sent it in Bale:
    // check Bale first, so they don't depend on the verify button alone.
    if (!user.baleChatId && (!cmd || cmd.name !== 'link') && (await hasPendingCode(tgId))) {
      const result = await pollBale();
      await notifyLinked(result.linkedNow, tgId);
      if (result.linkedNow.has(tgId)) {
        await reply(chatId, T.verifySuccess);
        user = await getUser(tgId);
        if (cmd && (cmd.name === 'start' || cmd.name === 'status')) return;
      }
    }

    if (cmd && (await handleCommand(cmd, chatId, tgId, user))) return;

    if (!user.baleChatId) {
      await sendLinkInstructions(chatId, tgId, {
        prefix: '⚠️ پیام شما فرستاده نشد، چون هنوز حساب بله‌ای متصل نکرده‌اید.',
      });
      return;
    }

    await forward(message, user);
  } catch (e) {
    console.error('message handler failed:', safeErrorText(e));
    await reply(chatId, '⚠️ خطای غیرمنتظره‌ای رخ داد. لطفاً دوباره امتحان کنید.');
  }
}
