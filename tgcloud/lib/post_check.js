// Is a Telegram channel post deleted? Bots get no update for a deletion,
// so the bot asks Telegram (Bale and Eitaa mirrors).
//
// editMessageReplyMarkup is answered from a copy Telegram keeps for the bot:
// measured live, it kept answering "message can't be edited" for posts
// deleted minutes earlier, until the channel's next post refreshed the copy.
// An empty reaction change is answered by Telegram itself (MESSAGE_ID_INVALID
// for a deleted post) and changes nothing in the channel. That answer is
// confirmed by forwarding the post to the channel owner's chat: a deleted
// post can't be forwarded, and a forward that does arrive is removed at once.

import { api } from 'sdk';
import { deletedPostAnswer } from './util.js';

async function answer(method, params) {
  try {
    return { ok: true, result: await api[method](params) };
  } catch (e) {
    return { ok: false, gone: deletedPostAnswer(e), error: e };
  }
}

export async function channelPostGone(chatId, messageId, ownerTgId) {
  const react = await answer('setMessageReaction', { chat_id: chatId, message_id: messageId, reaction: [] });
  if (react.ok) return false;
  if (!react.gone) {
    // Reactions refused for another reason (e.g. switched off in the
    // channel): fall back to the edit check, which is right when it says
    // "deleted".
    const edit = await answer('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId });
    return Boolean(edit.gone);
  }
  if (!ownerTgId) return true;
  const fwd = await answer('forwardMessage', {
    chat_id: ownerTgId, from_chat_id: chatId, message_id: messageId, disable_notification: true,
  });
  if (fwd.ok) {
    await api.deleteMessage({ chat_id: ownerTgId, message_id: fwd.result.message_id }).catch(() => null);
    return false;
  }
  // Not forwardable for another reason (protected channel, the owner blocked
  // the bot): the reaction's answer stands.
  return true;
}
