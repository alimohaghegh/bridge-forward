// Small helpers shared by handlers and lib modules.

import { sql } from 'sdk/db';

export const BALE_BOT_USERNAME = 'bridgeforward_bot';
export const TELEGRAM_BOT_USERNAME = 'bridgeforward_bot';

// Largest file Telegram lets a bot download (getFile cap).
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

export function now() {
  return Math.floor(Date.now() / 1000);
}

// The database's clock, for times that runs compare with each other (locks,
// leases, "album quiet", "stale"): the machines running the bot were seen
// with clocks more than a minute apart, the database has one clock.
export const DB_NOW = sql.raw("CAST(strftime('%s','now') AS INTEGER)");
export const DB_NOW_MS = sql.raw("CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)");

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

// Whether a Bot API error about a channel post (see lib/post_check.js) means
// the post was deleted: "MESSAGE_ID_INVALID" (reaction, forward, or an edit
// with edit rights) or "message to … not found" (seen live, 2026-11-03). An
// existing post's edit answers "message can't be edited" or "message is not
// modified".
export function deletedPostAnswer(e) {
  return Boolean(e && e.code === 400 && /message to (edit|forward|react) not found|MESSAGE_ID_INVALID/i.test(String(e.description)));
}

// Base64 and UTF-8 without btoa/TextEncoder (not all are in the runtime).
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function toBase64(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=';
    out += i + 2 < bytes.length ? B64[n & 63] : '=';
  }
  return out;
}

export function fromBase64(s) {
  const clean = String(s).replace(/=+$/, '');
  const out = [];
  let buf = 0;
  let bits = 0;
  for (const ch of clean) {
    const v = B64.indexOf(ch);
    if (v < 0) continue;
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >> bits) & 255);
    }
  }
  return new Uint8Array(out);
}

export function utf8Encode(s) {
  if (typeof TextEncoder === 'function') return new TextEncoder().encode(s);
  const out = [];
  for (const ch of String(s)) {
    let c = ch.codePointAt(0);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return new Uint8Array(out);
}

export function utf8Decode(bytes) {
  if (typeof TextDecoder === 'function') return new TextDecoder().decode(bytes);
  let s = '';
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i];
    let c;
    let n;
    if (b < 0x80) { c = b; n = 1; } else if (b < 0xe0) { c = b & 31; n = 2; } else if (b < 0xf0) { c = b & 15; n = 3; } else { c = b & 7; n = 4; }
    for (let k = 1; k < n; k++) c = (c << 6) | (bytes[i + k] & 63);
    s += String.fromCodePoint(c);
    i += n;
  }
  return s;
}
