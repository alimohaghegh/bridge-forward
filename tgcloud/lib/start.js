// The Bale part of /start (now behind the menu's «ارسال پیام‌هایم به بله»):
// the link status for linked users, else the linking code and buttons.

import { api } from 'sdk';
import { createCode, getOrCreateCode } from './linking.js';
import { getUser } from './store.js';
import { linkInstructions, statusText, baleStartLink, VERIFY_BUTTON, OPEN_BALE_BUTTON } from './texts.js';

export async function sendLinkInstructions(chatId, tgId, { fresh, prefix } = {}) {
  const { code, minutesLeft } = fresh ? await createCode(tgId) : await getOrCreateCode(tgId);
  const text = (prefix ? prefix + '\n\n' : '') + linkInstructions(code, minutesLeft);
  try {
    await api.sendMessage({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: {
        inline_keyboard: [
          [{ text: OPEN_BALE_BUTTON, url: baleStartLink(code) }],
          [{ text: VERIFY_BUTTON, callback_data: 'verify' }],
        ],
      },
    });
  } catch (e) {
    console.warn('reply failed', e && e.code);
  }
}

export async function runStartFlow(chatId, tgId) {
  const user = await getUser(tgId);
  if (user && user.baleChatId) {
    await api.sendMessage({ chat_id: chatId, text: statusText(user) + '\n\nراهنما: /help', link_preview_options: { is_disabled: true } })
      .catch((e) => console.warn('reply failed', e && e.code));
  } else {
    await sendLinkInstructions(chatId, tgId);
  }
}
