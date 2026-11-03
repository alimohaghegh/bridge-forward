// Showing a screen (a message with buttons) in Telegram.

import { api } from 'sdk';
import { MENU } from './texts.js';

export const HOME_ROW = [{ text: MENU.home, callback_data: 'm:home' }];

// Shows a screen: edits the button's message when `where.cq` is given, else
// sends a new message to `where.chatId`. Failures are logged (a refused
// screen once made /start silently do nothing); if Telegram refuses the
// HTML, the text goes out plain. Returns true when something was shown.
export async function show(where, text, keyboard) {
  const extra = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } };
  if (keyboard) extra.reply_markup = { inline_keyboard: keyboard };
  if (where.cq && where.cq.message) {
    try {
      await api.editMessageText({ chat_id: where.cq.message.chat.id, message_id: where.cq.message.message_id, text, ...extra });
      return true;
    } catch (e) {
      if (e && /not modified/i.test(String(e.description))) return true;
    }
  }
  const chatId = where.chatId || (where.cq && where.cq.from.id);
  try {
    await api.sendMessage({ chat_id: chatId, text, ...extra });
    return true;
  } catch (e) {
    console.error('show failed:', e && e.code, e && e.description);
    if (!(e && e.code === 400 && /parse|entit|tag/i.test(String(e.description)))) return false;
  }
  try {
    const { parse_mode: _p, ...plain } = extra;
    const stripped = text.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    await api.sendMessage({ chat_id: chatId, text: stripped, ...plain });
    return true;
  } catch (e) {
    console.error('show failed again:', e && e.code, e && e.description);
    return false;
  }
}
