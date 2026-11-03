// handlers/my_chat_member.js — the bot's own status changed in a chat. Used
// for the Eitaa mirror: when someone makes the bot admin of a channel, they
// are asked (in their chat with the bot) to continue linking; when the bot
// is removed, that channel's mirror stops.

import { onMyChatMember } from '../lib/eitaa_link.js';

export default async function (update) {
  try {
    await onMyChatMember(update);
  } catch (e) {
    console.error('my_chat_member handler failed:', e && e.name);
  }
}
