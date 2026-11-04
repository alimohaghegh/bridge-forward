// handlers/message.js — every private message: commands, the steps of the
// linking flows (Bale account, Bale channel, Eitaa channel) and forwarding to
// the user's Bale chat. Screens and buttons live in lib/ (bale_ui.js,
// eitaa_link.js). Message contents are never stored or logged.

import { api, db } from 'sdk';
import { sql } from 'sdk/db';
import { safeErrorText, isSystemError } from '../lib/bale.js';
import { isSupported, deliver, deliverAlbum } from '../lib/forward.js';
import { isAlbumItem, collectAlbum, releaseAlbumItems } from '../lib/album.js';
import { drainAll, probeStats } from '../lib/mirror.js';
import { drainEitaa } from '../lib/eitaa_mirror.js';
import {
  showMenu, showHelp, isEitaaStep, handleEitaaStep, handleOwnerReply, looksLikeEitaaToken, listRequests, cancelStep,
} from '../lib/eitaa_link.js';
import { runEitaaDiag, runMethodsDiag, runSizeDiag, runEitaaCiProbe, runEitaaState } from '../lib/eitaa_diag.js';
import {
  sendLinkInstructions, showAccount, showLinked, sendTest, unlinkAccount, showBaleChannels, startBaleChannel, handleBaleStep,
} from '../lib/bale_ui.js';
import { loadBaleFormat, runBaleFmtDiag } from '../lib/bale_fmt.js';
import { clearPending, activePending, telegramChannelTitle } from '../lib/channels.js';
import { hasPendingCode, pollBale, notifyLinked } from '../lib/linking.js';
import { ADMIN_COMMANDS, runAdminCommand } from '../lib/admin.js';
import { runSetup } from '../lib/setup.js';
import { runAlbumPrepare, albumTestPost, runAlbumReport, runAlbumCleanup, runAlbumVariants, runBaleSelfChat } from '../lib/album_test.js';
import channelPost from './channel_post.js';
import {
  runDiag, runBaleProbe, formatProbe, runMirrorTest, runBaleState, formatDeleteLog, formatCallLog, runBurstPrepare, runBurstReport, runProbeMethods,
} from '../lib/diag.js';
import {
  touchUser, getUser, claimMessage, maybeCleanup, countDelivery, isOwner, recordBaleSuccess, recordBaleFailure,
} from '../lib/store.js';
import { T, E, B } from '../lib/texts.js';
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
// Every command a user needs is also a button; these remain for those who
// type them.
async function handleCommand(cmd, chatId, tgId, user) {
  const where = { chatId };
  switch (cmd.name) {
    case 'start':
    case 'menu':
      await showMenu(where, tgId);
      return true;
    case 'help':
      await showHelp(where);
      return true;
    case 'status':
      await showAccount(where, tgId);
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
      await unlinkAccount(where, tgId);
      return true;
    case 'test':
      await sendTest(where, tgId);
      return true;
    case 'channel':
      await startBaleChannel(where, tgId);
      return true;
    case 'channels':
      await showBaleChannels(where, tgId);
      return true;
    case 'cancel':
      await cancelStep(where, tgId);
      return true;
  }
  if (!isOwner(tgId)) return false;

  if (cmd.name === 'sync') {
    const r = await drainAll();
    const labels = { empty: 'همه رسیده', retry: 'منتظر بله', busy: 'در حال ارسال', waiting: 'در حال جمع کردن آلبوم', timeout: 'ادامه در نوبت بعد' };
    const lines = [];
    for (const [id, status] of Object.entries(r)) lines.push(`${await telegramChannelTitle(Number(id))}: ${labels[status] || status}`);
    await reply(chatId, '🔄 ' + (lines.join('\n') || 'کانالی متصل نیست'));
    return true;
  }
  if (cmd.name === 'eitaa_diag') {
    const [sub, extra] = cmd.arg.toLowerCase().split(/\s+/);
    if (sub === 'methods') await runMethodsDiag();
    else if (sub === 'size') await runSizeDiag(extra);
    else await runEitaaDiag();
    return true;
  }
  if (cmd.name === 'bale_diag' || cmd.name === 'diag') {
    if (cmd.arg.toLowerCase() === 'fmt') await runBaleFmtDiag(chatId);
    else if (cmd.arg.toLowerCase() === 'deletes') await reply(chatId, await formatDeleteLog());
    else if (cmd.arg.toLowerCase() === 'calls') await reply(chatId, await formatCallLog());
    else await reply(chatId, formatProbe(await runBaleProbe(user.baleChatId, '🔧 آزمایش اتصال (از طرف مدیر ربات)')) + '\n\nقالب‌بندی: /bale_diag fmt');
    return true;
  }
  if (cmd.name === 'requests') {
    await listRequests(chatId);
    return true;
  }
  if (ADMIN_COMMANDS.has(cmd.name)) {
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

// Runs started by `tgcloud run` from CI (real updates always carry
// ctx.update and never these fields). Outputs land in public CI logs:
// counts and codes only.
const CI_RUNS = {
  __setup: runSetup,
  __diag: runDiag,
  __mirrortest: runMirrorTest,
  __bale_state: runBaleState,
  __burst_prepare: runBurstPrepare,
  __burst_report: runBurstReport,
  __probe_methods: runProbeMethods,
  __album_prepare: runAlbumPrepare,
  __album_item: async (m) => { await channelPost(await albumTestPost(m)); return { ok: true }; },
  __album_report: runAlbumReport,
  __album_cleanup: runAlbumCleanup,
  __album_variants: runAlbumVariants,
  __bale_self: runBaleSelfChat,
  __eitaa: runEitaaCiProbe,
  __eitaa_state: runEitaaState,
  // Retry queued channel posts and find deletions (Bale and Eitaa side by side).
  __drain: async () => {
    const [baleById, eitaa] = await Promise.all([drainAll(), drainEitaa(10000)]);
    const bale = {};
    for (const status of Object.values(baleById)) bale[status] = (bale[status] || 0) + 1;
    // This machine's clock minus the database's (clocks were seen to differ).
    const db0 = await db.get(sql`SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS ms`);
    return { bale, baleProbe: { ...probeStats }, eitaa, skewMs: Date.now() - Number(db0.ms) };
  },
};

export default async function (message, ctx) {
  await loadBaleFormat();
  if (!(ctx && ctx.update) && message) {
    const run = Object.keys(CI_RUNS).find((k) => message[k] === true);
    if (run) return CI_RUNS[run](message);
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
        await showLinked(chatId);
        user = await getUser(tgId);
        if (cmd && (cmd.name === 'start' || cmd.name === 'status')) return;
      }
    }

    const step = activePending(user);
    if (step && cmd) {
      // Any command ends a pending step.
      if (cmd.name !== 'cancel') await clearPending(tgId);
    } else if (step && isEitaaStep(step)) {
      if (await handleEitaaStep(step, message, user)) return;
    } else if (step && (await handleBaleStep(step, message, user))) {
      return;
    }

    // An EitaaYar token sent outside its step: delete it, never forward it.
    if (!cmd && (looksLikeEitaaToken(message.text) || looksLikeEitaaToken(message.caption))) {
      await api.deleteMessage({ chat_id: chatId, message_id: message.message_id }).catch(() => null);
      await reply(chatId, E.tokenLeakWarn);
      return;
    }

    if (cmd && (await handleCommand(cmd, chatId, tgId, user))) return;

    // Not linked to Bale: nothing to forward to. Show the menu instead of a
    // linking code — most users come for the channel bridges.
    if (!user.baleChatId) {
      await showMenu({ chatId }, tgId, B.notDelivered);
      return;
    }

    await forward(message, user);
  } catch (e) {
    console.error('message handler failed:', safeErrorText(e));
    await reply(chatId, '⚠️ خطای غیرمنتظره‌ای رخ داد. لطفاً دوباره امتحان کنید.');
  }
}
