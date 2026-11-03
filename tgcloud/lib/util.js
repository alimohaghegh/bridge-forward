// Small helpers shared by handlers and lib modules.

export const BALE_BOT_USERNAME = 'bridgeforward_bot';
export const TELEGRAM_BOT_USERNAME = 'bridgeforward_bot';

// Largest file Telegram lets a bot download (getFile cap).
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

export function now() {
  return Math.floor(Date.now() / 1000);
}

// Resolves true after `ms`, or false right away when the runtime has no timer.
export async function sleep(ms) {
  if (typeof setTimeout !== 'function') return false;
  await new Promise((resolve) => setTimeout(resolve, ms));
  return true;
}

// Rows from a `.returning()` builder or a raw run result.
export function rowsOf(result) {
  if (Array.isArray(result)) return result;
  return (result && result.rows) || [];
}

export function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Splits text into chunks of at most `max` UTF-16 units, preferring line and
// word boundaries.
export function splitText(text, max) {
  const parts = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(' ', max);
    if (cut < max * 0.5) cut = max;
    // Never split a surrogate pair.
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest.length) parts.push(rest);
  return parts;
}

// Persian and Arabic-Indic digits → ASCII.
export function toAsciiDigits(s) {
  return s
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
}

export function formatDate(unixSeconds) {
  if (!unixSeconds) return '-';
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}
