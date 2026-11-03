// Which Markdown Bale really renders, as answered by the bot owner in
// /bale_diag fmt (stored under the settings key 'bale_fmt'), and the
// diagnostic itself. Until answered, format.js formats links only.

import { api, InputFile } from 'sdk';
import { baleCall } from './bale.js';
import { getSetting, setSetting } from './eitaa.js';
import { diagPngBytes } from './eitaa_diag.js';
import { setBaleFormat } from './format.js';
import { getUser } from './store.js';
import { OWNER_TELEGRAM_ID } from './config.js';

const CACHE_MS = 60 * 1000;
let loadedAt = 0;

// Loads the stored answers into format.js (cached for a minute). Called at
// the start of every handler run that may format text for Bale.
export async function loadBaleFormat() {
  if (Date.now() - loadedAt < CACHE_MS) return;
  try {
    setBaleFormat(await getSetting('bale_fmt', null));
    loadedAt = Date.now();
  } catch {
    // Keep the defaults (links only).
  }
}

const ZW = '​';
const URL = 'https://bale.ai';

// [key, probe text, button label]. Probes 1–8 and 11: "did it render as
// formatting?"; 9–10: "did the characters show literally (no formatting,
// no visible backslash)?".
const PROBES = [
  ['b1', '1) *a*', '1 بولد'],
  ['b2', '2) **a**', '2 بولد'],
  ['i1', '3) _a_', '3 ایتالیک'],
  ['i2', '4) __a__', '4 ایتالیک'],
  ['punct', '5) (*a*) «*a*» *a*، *a*.', '5 کنار علامت'],
  ['glued', '6) سلام*a*سلام', '6 چسبیده'],
  ['zwnj', '7) می‌*a*‌شود', '7 نیم‌فاصله'],
  ['link', `8) [متن لینک](${URL})`, '8 لینک'],
  ['esc_bs', `9) \\*a\\* \\_a\\_ \\[a](${URL})`, '9 \\ درست'],
  ['esc_zw', `10) *${ZW}a*${ZW} _${ZW}a_${ZW} [${ZW}a]${ZW}(${URL})`, '10 ZWSP درست'],
  ['cap', `11) *a* _b_ [c](${URL})`, '11 کپشن'],
];

function keyboard(selected) {
  const rows = [];
  for (let i = 0; i < PROBES.length; i += 3) {
    rows.push(PROBES.slice(i, i + 3).map(([key, , label]) => ({
      text: `${selected.includes(key) ? '✅' : '⬜️'} ${label}`, callback_data: `bd:f:${key}`,
    })));
  }
  rows.push([{ text: '💾 ذخیره', callback_data: 'bd:fs' }]);
  return rows;
}

export async function runBaleFmtDiag(chatId) {
  const owner = await getUser(OWNER_TELEGRAM_ID);
  if (!owner || !owner.baleChatId) {
    await api.sendMessage({ chat_id: chatId, text: 'ℹ️ اول حساب بلهٔ خودتان را وصل کنید (ارسال پیام به بله)، بعد دوباره /bale_diag fmt بزنید.' }).catch(() => null);
    return;
  }
  const results = [];
  for (const [key, text] of PROBES) {
    const r = key === 'cap'
      ? await baleCall('sendPhoto', { chat_id: owner.baleChatId, caption: text }, { photo: new InputFile(diagPngBytes(), 'diag.png', { type: 'image/png' }) })
      : await baleCall('sendMessage', { chat_id: owner.baleChatId, text });
    results.push(`${text.slice(0, 3)} ${r.ok ? '✅' : '❌ ' + (r.error_code || '') + ' ' + String(r.description || '').slice(0, 60)}`);
  }
  await setSetting('bale_fmt_draft', []);
  await api.sendMessage({
    chat_id: chatId,
    text: [
      '🔤 آزمایش قالب‌بندی بله — ۱۱ پیام به بلهٔ خودتان فرستاده شد:',
      results.join('\n'),
      '',
      'در بله نگاه کنید و دکمه‌ها را بزنید:',
      '• ۱ تا ۸ و ۱۱: اگر واقعاً بولد/ایتالیک/لینک شد (نه به‌صورت علامت خام).',
      '• ۹ و ۱۰: اگر علامت‌ها ساده و بدون قالب‌بندی دیده شدند (و در ۹ بک‌اسلش دیده نشد).',
      'بعد «ذخیره» را بزنید.',
    ].join('\n'),
    reply_markup: { inline_keyboard: keyboard([]) },
  }).catch(() => null);
}

// What the answers mean for format.js.
export function formatFromAnswers(a) {
  const has = (k) => a.includes(k);
  return {
    answered: true,
    bold: has('b1') ? '*' : has('b2') ? '**' : null,
    italic: has('i1') ? '_' : has('i2') ? '__' : null,
    link: has('link'),
    punct: has('punct'),
    glued: has('glued'),
    zwnj: has('zwnj'),
    escape: has('esc_zw') || !has('esc_bs') ? 'zwsp' : 'backslash',
    caption: has('cap'),
  };
}

// bd:f:<key> toggles an answer, bd:fs saves.
export async function onBaleFmtButton(cq) {
  const draft = await getSetting('bale_fmt_draft', []);
  if (cq.data === 'bd:fs') {
    const fmt = formatFromAnswers(draft);
    await setSetting('bale_fmt', fmt);
    loadedAt = 0;
    const yes = (v) => (v ? 'بله' : 'نه');
    await api.editMessageText({
      chat_id: cq.message.chat.id, message_id: cq.message.message_id,
      text: [
        '💾 ذخیره شد. از این به بعد در بله:',
        `بولد: ${fmt.bold || 'خاموش'} · ایتالیک: ${fmt.italic || 'خاموش'} · لینک: ${yes(fmt.link)}`,
        `کنار علامت‌ها: ${yes(fmt.punct)} · چسبیده به حروف: ${yes(fmt.glued)} · نیم‌فاصله: ${yes(fmt.zwnj)}`,
        `خنثی‌کردن علامت‌های کاربر: ${fmt.escape === 'zwsp' ? 'فاصلهٔ صفر' : 'بک‌اسلش'} · قالب در کپشن: ${yes(fmt.caption)}`,
      ].join('\n'),
    }).catch(() => null);
    return;
  }
  const key = cq.data.slice(5);
  if (!PROBES.some(([k]) => k === key)) return;
  const next = draft.includes(key) ? draft.filter((k) => k !== key) : [...draft, key];
  await setSetting('bale_fmt_draft', next);
  await api.editMessageReplyMarkup({
    chat_id: cq.message.chat.id, message_id: cq.message.message_id, reply_markup: { inline_keyboard: keyboard(next) },
  }).catch(() => null);
}
