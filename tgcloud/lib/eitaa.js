// Minimal client for the EitaaYar API (https://eitaayar.ir/api/<token>/<method>),
// token encryption for advanced mode, and the stored diagnostic findings.
// Never log a request URL or a token: the token is part of the URL.
//
// Telegram Serverless can't connect to Eitaa's network, so calls go through
// the Cloudflare relay (lib/relay.js) when it is configured.

import { fetch, FormData, db } from 'sdk';
import { sql } from 'sdk/db';
import * as CONFIG from './config.js';
import { now, toBase64, fromBase64, utf8Encode, utf8Decode } from './util.js';
import { RELAY_URL, relayEnabled, relayHeaders } from './relay.js';

export { RELAY_URL, relayEnabled };

const DIRECT = 'https://eitaayar.ir';
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
  const path = '/api/' + token + '/' + method;
  const url = (relayEnabled() ? RELAY_URL : DIRECT) + path;
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
    const init = { method: 'POST', body };
    if (relayEnabled()) init.headers = await relayHeaders(path);
    res = await fetch(url, init);
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
  // The relay itself refused or couldn't reach Eitaa: keep posts queued.
  if (desc.startsWith('relay:')) return 'unavailable';
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

// Telegram Serverless's outbound proxy could not connect to Eitaa's network
// at all (measured 2026-11-03: every Eitaa host fails, other Iranian sites
// work). Checked before a user starts linking; cached for a few minutes.
const REACH_TTL_SECONDS = 5 * 60;


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

// True when EitaaYar answers at all (any HTTP answer from it counts).
export async function eitaaReachable() {
  const cached = await getSetting('reach', null);
  if (cached && now() - cached.at < REACH_TTL_SECONDS) return cached.ok;
  const r = await rawCall(SHARED_TOKEN || 'bot0:00000000-0000-0000-0000-000000000000', 'getMe', {});
  const ok = r.ok || (!r.network && typeof r.ok === 'boolean' && r.http < 500);
  await setSetting('reach', { ok, at: now() });
  return ok;
}

// HTML tags verified live in Eitaa (eitaa_html.js never emits others).
export const DEFAULT_TAGS = ['b', 'i', 'code', 'a'];
export const DEFAULT_TEXT_LIMIT = 4096;
export const DEFAULT_CAPTION_LIMIT = 1024;

// Everything a send needs to know, in one read.
export async function eitaaCaps() {
  const caps = await getSetting('caps', {});
  return {
    // Fixed, not taken from a stored answer: a save with nothing ticked once
    // switched all formatting off. These tags and &amp; &lt; &gt; were
    // verified live in Eitaa.
    tags: DEFAULT_TAGS,
    escapesOk: true,
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
