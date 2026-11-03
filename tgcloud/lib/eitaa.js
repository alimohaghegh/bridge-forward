// Minimal client for the EitaaYar API (https://eitaayar.ir/api/<token>/<method>),
// token encryption for advanced mode, and the stored diagnostic findings.
// Never log a request URL or a token: the token is part of the URL.

import { fetch, FormData, db } from 'sdk';
import { sql } from 'sdk/db';
import * as CONFIG from './config.js';
import { now } from './util.js';

const BASE = 'https://eitaayar.ir/api/';
const NETWORK_RETRY_MS = 9000;

// Read through a namespace import: an older config.js without these names
// must not break the whole bot.
export const SHARED_TOKEN = String(CONFIG.EITAA_YAR_TOKEN || '');
export const OPERATOR_USERNAME = String(CONFIG.EITAA_OPERATOR_USERNAME || '').replace(/^@/, '');
const TOKEN_KEY = String(CONFIG.EITAA_TOKEN_KEY || '');

// Simple mode needs the shared token and the operator's Eitaa account;
// advanced mode needs the key that protects stored tokens.
export function simpleModeEnabled() {
  return Boolean(SHARED_TOKEN && OPERATOR_USERNAME);
}

export function advancedModeEnabled() {
  return Boolean(TOKEN_KEY);
}

const knownTokens = new Set();

// Text with every token we know of replaced, for logs and diagnostics.
export function redact(text) {
  let s = String(text || '');
  for (const t of [SHARED_TOKEN, ...knownTokens]) if (t) s = s.split(t).join('<token>');
  return s.replace(/bot\d+:[0-9a-f-]{12,}/gi, '<token>');
}

// Plain fields as strings, objects as JSON.
function fields(params, into) {
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === '') continue;
    into(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
}

async function rawCall(token, method, params, file) {
  knownTokens.add(token);
  const url = BASE + token + '/' + method;
  let body;
  if (file) {
    body = new FormData();
    fields(params, (k, v) => body.append(k, v));
    body.append('file', file);
  } else {
    const form = {};
    fields(params, (k, v) => { form[k] = v; });
    body = fetch.body.form(form);
  }

  const t0 = Date.now();
  let res;
  try {
    res = await fetch(url, { method: 'POST', body });
  } catch (e) {
    return { ok: false, error_code: 0, description: 'network error', network: true, detail: redact(e && e.message), ms: Date.now() - t0 };
  }
  let text = '';
  try {
    text = await res.text();
  } catch {
    text = '';
  }
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  const ms = Date.now() - t0;
  if (!data || typeof data !== 'object' || typeof data.ok !== 'boolean') {
    return {
      ok: false, error_code: res.status, description: 'unexpected response', http: res.status,
      network: res.status >= 500, snippet: redact(text.slice(0, 120)), ms,
    };
  }
  data.http = res.status;
  data.ms = ms;
  if (!data.ok && data.description) data.description = redact(data.description);
  return data;
}

// Calls an EitaaYar method. Returns the envelope ({ ok: true, result } or
// { ok: false, error_code, description, … }); never throws. Network errors
// are retried while NETWORK_RETRY_MS lasts (the platform's connections are
// flaky); everything else is returned as is. With `file` (an InputFile) the
// call is multipart.
export async function eitaaCall(token, method, params, file) {
  const started = Date.now();
  let r = await rawCall(token, method, params, file);
  for (let attempt = 1; attempt < 3 && !r.ok && r.network && Date.now() - started < NETWORK_RETRY_MS; attempt++) {
    r = await rawCall(token, method, params, file);
  }
  return r;
}

export async function eitaaCallOnce(token, method, params, file) {
  return rawCall(token, method, params, file);
}

// Sorts a failed call into a reason the bot can explain:
// unavailable / rate (try again later), auth (bad token), chat (bad channel
// or @sender is not a manager), too_large, rejected (this post only).
export function classifyEitaa(r) {
  if (r.ok) return null;
  const code = Number(r.error_code) || 0;
  const desc = String(r.description || '').toLowerCase();
  if (r.network || code === 0 || code >= 500 || r.http >= 500) return 'unavailable';
  if (code === 429 || /too many|flood|rate/.test(desc)) return 'rate';
  if (code === 401 || /token|unauthori[sz]ed|توکن/.test(desc)) return 'auth';
  if (code === 413 || /too large|too big|size|حجم/.test(desc)) return 'too_large';
  if (code === 403 || /chat|channel|admin|forbidden|کانال|مدیر/.test(desc)) return 'chat';
  return 'rejected';
}

export function isTemporary(reason) {
  return reason === 'unavailable' || reason === 'rate';
}

// A short, token-free description of a failed call, for the owner.
export function describeFailure(r) {
  if (r.network) return 'network: ' + (r.detail || 'request failed').slice(0, 80);
  const parts = [];
  if (r.error_code) parts.push('code=' + r.error_code);
  if (r.http && r.http !== r.error_code) parts.push('http=' + r.http);
  if (r.description) parts.push(String(r.description).slice(0, 160));
  if (r.snippet) parts.push(r.snippet);
  return redact(parts.join(' ')) || 'unknown';
}

export function messageIdOf(r) {
  const m = r && r.result;
  if (m && (typeof m.message_id === 'number' || typeof m.message_id === 'string')) return Number(m.message_id);
  return null;
}

// ── Stored findings (eitaa_settings) ────────────────────────────────────────

export async function getSetting(key, fallback) {
  const row = await db.get(sql`SELECT value FROM eitaa_settings WHERE key = ${key}`);
  if (!row || row.value === null || row.value === undefined) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return fallback;
  }
}

export async function setSetting(key, value) {
  await db.run(sql`
    INSERT INTO eitaa_settings (key, value, updated_at) VALUES (${key}, ${JSON.stringify(value)}, ${now()})
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`);
}

// HTML tags known to render in Eitaa. Until /eitaa_diag fmt is answered,
// the common Telegram-style set.
export const DEFAULT_TAGS = ['b', 'i', 'u', 's', 'a', 'code', 'pre'];
export const DEFAULT_TEXT_LIMIT = 4096;
export const DEFAULT_CAPTION_LIMIT = 1024;

// Everything a send needs to know, in one read.
export async function eitaaCaps() {
  const caps = await getSetting('caps', {});
  return {
    tags: Array.isArray(caps.tags) ? caps.tags : DEFAULT_TAGS,
    escapesOk: caps.escapesOk !== false,
    textLimit: Number(caps.textLimit) || DEFAULT_TEXT_LIMIT,
    captionLimit: Number(caps.captionLimit) || DEFAULT_CAPTION_LIMIT,
    limitCountsMarkup: caps.limitCountsMarkup !== false,
    editMethod: caps.editMethod || null,
    editCaptionMethod: caps.editCaptionMethod || null,
    deleteMethod: caps.deleteMethod || null,
  };
}

export async function updateCaps(patch) {
  const caps = await getSetting('caps', {});
  await setSetting('caps', { ...caps, ...patch });
}

// ── Token encryption (advanced mode) ────────────────────────────────────────
// AES-GCM with a key derived as SHA-256(EITAA_TOKEN_KEY). Stored as
// "v1:<iv b64>:<ciphertext b64>". Without WebCrypto the token is stored as
// "plain:<token>" (documented in the README).

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function toBase64(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=';
    out += i + 2 < bytes.length ? B64[n & 63] : '=';
  }
  return out;
}

function fromBase64(s) {
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

function utf8Decode(bytes) {
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

function subtle() {
  const c = globalThis.crypto;
  return c && c.subtle && typeof c.subtle.encrypt === 'function' && typeof c.getRandomValues === 'function' ? c.subtle : null;
}

export function webCryptoAvailable() {
  return Boolean(subtle());
}

async function aesKey() {
  const s = subtle();
  const digest = await s.digest('SHA-256', utf8Encode(TOKEN_KEY));
  return s.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptToken(token) {
  const s = subtle();
  if (!s) return 'plain:' + token;
  const iv = new Uint8Array(12);
  globalThis.crypto.getRandomValues(iv);
  const ct = await s.encrypt({ name: 'AES-GCM', iv }, await aesKey(), utf8Encode(token));
  return 'v1:' + toBase64(iv) + ':' + toBase64(new Uint8Array(ct));
}

// Returns the token, or null when it can't be read (key changed).
export async function decryptToken(stored) {
  const s = String(stored || '');
  if (s.startsWith('plain:')) return s.slice(6);
  const m = s.match(/^v1:([^:]+):(.+)$/);
  if (!m || !subtle() || !TOKEN_KEY) return null;
  try {
    const pt = await subtle().decrypt({ name: 'AES-GCM', iv: fromBase64(m[1]) }, await aesKey(), fromBase64(m[2]));
    const token = utf8Decode(new Uint8Array(pt));
    knownTokens.add(token);
    return token;
  } catch {
    return null;
  }
}

// The token a mirror sends with, or null.
export async function channelToken(ch) {
  if (ch.mode === 'simple') return SHARED_TOKEN || null;
  if (ch.mode === 'advanced') return decryptToken(ch.tokenEnc || ch.token_enc);
  return null;
}
