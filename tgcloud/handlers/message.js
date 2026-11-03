// handlers/message.js — every private message: the main menu, commands,
// linking prompts (Bale account, Bale channel, Eitaa channel) and forwarding
// to the user's Bale chat. Message contents are never stored or logged.

import { api } from 'sdk';
import { baleCall, classifyError, isSystemError, safeErrorText } from '../lib/bale.js';
import { isSupported, deliver, deliverAlbum } from '../lib/forward.js';
import { isAlbumItem, collectAlbum, releaseAlbumItems } from '../lib/album.js';
import { drainAll } from '../lib/mirror.js';
import { drainEitaa } from '../lib/eitaa_mirror.js';
import {
  showMenu, showHelp, isEitaaStep, handleEitaaStep, handleOwnerReply, looksLikeEitaaToken, listRequests,
} from '../lib/eitaa_link.js';
import {
  runEitaaDiag, runFmtDiag, runFmt2Diag, runFmt3Diag, runFmt4Diag, runEitaaRender, runEitaaResend, runMethodsDiag, runSizeDiag, runEitaaCiProbe, runEitaaState, gatewayProbe,
} from '../lib/eitaa_diag.js';
import { sendLinkInstructions } from '../lib/start.js';
import { loadBaleFormat, runBaleFmtDiag } from '../lib/bale_fmt.js';
import {
  listChannels, saveChannel, setPending, clearPending, activePending, telegramChannelRef,
  checkTelegramChannel, baleChannelRef, checkBaleChannel, telegramChannelTitle, confirmBaleTarget,
} from '../lib/channels.js';
import {
  deletePendingCodes, hasPendingCode, pollBale, notifyLinked, createChannelCode,
} from '../lib/linking.js';
import { ADMIN_COMMANDS, runAdminCommand } from '../lib/admin.js';
import { runSetup } from '../lib/setup.js';
import { runDiag, runBaleProbe, formatProbe, runDeleteProbe, runMirrorTest } from '../lib/diag.js';
import {
  touchUser, getUser, clearLink, claimMessage, maybeCleanup, countDelivery, isOwner,
  recordBaleSuccess, recordBaleFailure,
} from '../lib/store.js';
import { T, E, statusText, VERIFY_CHANNEL_BUTTON } from '../lib/texts.js';
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
    case 'menu':
      // The Bale part of the old /start is the menu's first button.
      await showMenu({ chatId }, tgId);
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
      await showHelp({ chatId });
      return true;

    case 'channel':
      if (!user.baleChatId) {
        await reply(chatId, T.chNeedLink);
        return true;
      }
      await setPending(tgId, 'tg_channel');
      await replyHtml(chatId, T.chStep1);
      return true;

    case 'channels':
      await sendChannelList(chatId, tgId);
      return true;

    case 'cancel':
      if (activePending(user)) {
        await clearPending(tgId);
        await reply(chatId, T.chCancelled);
      } else {
        await reply(chatId, T.chNothingToCancel);
      }
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

  if (cmd.name === 'sync' && isOwner(tgId)) {
    const r = await drainAll();
    const labels = { empty: 'همه رسیده', retry: 'منتظر بله', busy: 'در حال ارسال', waiting: 'در حال جمع کردن آلبوم', timeout: 'ادامه در نوبت بعد' };
    const lines = [];
    for (const [id, status] of Object.entries(r)) lines.push(`${await telegramChannelTitle(Number(id))}: ${labels[status] || status}`);
    await reply(chatId, '🔄 ' + (lines.join('\n') || 'کانالی متصل نیست'));
    return true;
  }

  if (cmd.name === 'eitaa_diag' && isOwner(tgId)) {
    const [sub, extra] = cmd.arg.toLowerCase().split(/\s+/);
    if (sub === 'fmt') await runFmtDiag();
    else if (sub === 'fmt2') await reply(chatId, '🔤 ' + JSON.stringify(await runFmt2Diag(), null, 1));
    else if (sub === 'methods') await runMethodsDiag();
    else if (sub === 'size') await runSizeDiag(extra);
    else if (sub === 'gateway') await reply(chatId, '🌐 ' + JSON.stringify(await gatewayProbe(), null, 1));
    else await runEitaaDiag();
    return true;
  }

  if (cmd.name === 'bale_diag' && isOwner(tgId)) {
    if (cmd.arg.toLowerCase() === 'fmt') await runBaleFmtDiag(chatId);
    else await reply(chatId, formatProbe(await runBaleProbe(user.baleChatId, '🔧 آزمایش اتصال (از طرف مدیر ربات)')) + '\n\nقالب‌بندی: /bale_diag fmt');
    return true;
  }

  if (cmd.name === 'requests' && isOwner(tgId)) {
    await listRequests(chatId);
    return true;
  }

  if (cmd.name === 'diag' && isOwner(tgId)) {
    await reply(chatId, formatProbe(await runBaleProbe(user.baleChatId, '🔧 آزمایش اتصال (از طرف مدیر ربات)')));
    return true;
  }

  if (ADMIN_COMMANDS.has(cmd.name) && isOwner(tgId)) {
    await replyHtml(chatId, await runAdminCommand(cmd.name, cmd.arg));
    return true;
  }
  return false;
}

async function sendChannelList(chatId, tgId) {
  const list = await listChannels(tgId);
  if (!list.length) {
    await reply(chatId, T.chListEmpty);
    return;
  }
  const buttons = [];
  for (const ch of list) {
    const title = await telegramChannelTitle(ch.tgChannelId);
    buttons.push([{ text: T.chUnlinkButton(title), callback_data: `unch:${ch.tgChannelId}` }]);
  }
  await reply(chatId, T.chListHeader, { reply_markup: { inline_keyboard: buttons } });
}

// A reply to a /channel step. Returns true when the message was consumed.
async function handleChannelStep(step, message, user) {
  const chatId = message.chat.id;
  const tgId = message.from.id;

  if (step === 'tg_channel') {
    const ref = telegramChannelRef(message);
    if (!ref) {
      await reply(chatId, T.chStep1Bad);
      return true;
    }
    const tg = await checkTelegramChannel(ref, tgId);
    if (!tg.ok) {
      await reply(chatId, tg.text + '\n\nبرای انصراف: /cancel');
      return true;
    }
    await setPending(tgId, 'bale_channel', tg.id);
    const { code } = await createChannelCode(tgId, tg.id);
    await replyHtml(chatId, T.chStep2(tg.title, code), {
      reply_markup: { inline_keyboard: [[{ text: VERIFY_CHANNEL_BUTTON, callback_data: 'verify_ch' }]] },
    });
    return true;
  }

  if (step === 'bale_channel') {
    const ref = baleChannelRef(message.text);
    if (!ref) {
      await reply(chatId, T.chStep2Bad);
      return true;
    }
    await reply(chatId, T.chChecking);
    // Re-check the Telegram side: rights may have changed meanwhile.
    const tg = await checkTelegramChannel(user.pendingTgChannel, tgId);
    if (!tg.ok) {
      await clearPending(tgId);
      await reply(chatId, tg.text + '\n\nبرای شروع دوباره: /channel');
      return true;
    }
    const bale = await checkBaleChannel(ref, user.baleChatId, isOwner(tgId));
    if (!bale.ok) {
      await reply(chatId, bale.text + '\n\nبرای انصراف: /cancel');
      return true;
    }
    const confirm = await confirmBaleTarget(bale.id);
    if (!confirm.ok) {
      await reply(chatId, confirm.text + '\n\nبرای انصراف: /cancel');
      return true;
    }
    await saveChannel(tg.id, bale.id, tgId);
    await clearPending(tgId);
    await deletePendingCodes(tgId);
    await reply(chatId, T.chLinked(tg.title, bale.title) + (confirm.canDelete ? '' : '\n\n' + T.chCantDelete));
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

  // Album items are collected and sent together by one of the runs; the
  // others have nothing more to do.
  let result;
  let messageIds = [message.message_id];
  if (isAlbumItem(message)) {
    const items = await collectAlbum(message);
    if (!items) return;
    result = await deliverAlbum(user.baleChatId, items);
    await releaseAlbumItems(chatId, items);
    messageIds = items.map((it) => it.tg);
  } else {
    result = await deliver(user.baleChatId, message);
  }
  await countDelivery(tgId, result.ok);

  if (result.ok) {
    await recordBaleSuccess();
    for (const messageId of messageIds) {
      try {
        await api.setMessageReaction({
          chat_id: chatId,
          message_id: messageId,
          reaction: [{ type: 'emoji', emoji: '👍' }],
        });
      } catch {
        // Reactions are a nicety; ignore failures.
      }
    }
    return;
  }

  if (isSystemError(result.reason)) await recordBaleFailure('send/' + result.reason);
  await reply(chatId, T.fail[result.reason] || T.fail.rejected, {
    reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
  });
}

export default async function (message, ctx) {
  await loadBaleFormat();
  // Deploy-time setup, reachable only through `tgcloud run` (real updates
  // always carry ctx.update and never this field).
  if (!(ctx && ctx.update) && message && message.__setup === true) return runSetup();
  if (!(ctx && ctx.update) && message && message.__diag === true) return runDiag();
  if (!(ctx && ctx.update) && message && message.__probe === true) return runDeleteProbe();
  if (!(ctx && ctx.update) && message && message.__mirrortest === true) return runMirrorTest();
  if (!(ctx && ctx.update) && message && message.__eitaa === true) return runEitaaCiProbe();
  if (!(ctx && ctx.update) && message && message.__eitaa_state === true) return runEitaaState();
  if (!(ctx && ctx.update) && message && message.__eitaa_fmt2 === true) return runFmt2Diag();
  if (!(ctx && ctx.update) && message && message.__eitaa_fmt3 === true) return runFmt3Diag();
  if (!(ctx && ctx.update) && message && message.__eitaa_fmt4 === true) return runFmt4Diag();
  if (!(ctx && ctx.update) && message && message.__eitaa_render === true) return runEitaaRender();
  if (!(ctx && ctx.update) && message && message.__eitaa_resend) return runEitaaResend(message.__eitaa_resend);
  // Scheduled run (GitHub Actions): retry queued channel posts, find
  // deletions. The output lands in public CI logs: counts only, no ids.
  if (!(ctx && ctx.update) && message && message.__drain === true) {
    const [baleById, eitaa] = await Promise.all([drainAll(), drainEitaa(10000)]);
    const bale = {};
    for (const status of Object.values(baleById)) bale[status] = (bale[status] || 0) + 1;
    return { bale, eitaa };
  }

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

    // The bot owner answering a simple-mode Eitaa request.
    if (isOwner(tgId) && message.reply_to_message && (await handleOwnerReply(message))) return;

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

    const step = activePending(user);
    if (step && cmd) {
      // Any command ends a pending /channel setup (/channel restarts it).
      if (cmd.name !== 'cancel') await clearPending(tgId);
    } else if (step && isEitaaStep(step)) {
      if (await handleEitaaStep(step, message, user)) return;
    } else if (step && (await handleChannelStep(step, message, user))) {
      return;
    }

    // An EitaaYar token sent outside its step: delete it, never forward it.
    if (!cmd && (looksLikeEitaaToken(message.text) || looksLikeEitaaToken(message.caption))) {
      await api.deleteMessage({ chat_id: chatId, message_id: message.message_id }).catch(() => null);
      await reply(chatId, E.tokenLeakWarn);
      return;
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
