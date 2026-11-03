// Minimal client for the Bale Bot API (https://docs.bale.ai).
// Never log the request URL: it contains the bot token.

import { fetch, FormData } from 'sdk';
import { BALE_BOT_TOKEN } from './config.js';
import { sleep } from './util.js';

const BASE = 'https://tapi.bale.ai/bot';
const MAX_RETRY_WAIT_SECONDS = 10;
const NETWORK_RETRY_MS = 15500;

async function rawCall(method, params, files) {
  const url = BASE + BALE_BOT_TOKEN + '/' + method;
  let body;
  if (files) {
    // multipart/form-data: plain fields as strings, objects as JSON.
    body = new FormData();
    for (const [key, value] of Object.entries(params || {})) {
      if (value === undefined || value === null) continue;
      body.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
    for (const [key, file] of Object.entries(files)) body.append(key, file);
  } else {
    body = fetch.body.json(params || {});
  }

  let res;
  try {
    res = await fetch(url, { method: 'POST', body });
  } catch (e) {
    const detail = safeErrorText(e);
    console.warn('bale: network error on', method, detail);
    return { ok: false, error_code: 0, description: 'network error', network: true, detail };
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!data || typeof data.ok !== 'boolean') {
    console.warn('bale: unexpected response on', method, res.status);
    return { ok: false, error_code: res.status, description: 'unexpected response', network: res.status >= 500 };
  }
  if (!data.ok) console.warn('bale:', method, 'failed with', data.error_code, data.description);
  return data;
}

// Calls a Bale method. Returns the raw envelope ({ ok, result } or
// { ok: false, error_code, description, parameters }); never throws.
// From the platform, new connections to Bale often time out (after ~5 s, two
// in a row is common) while the next one succeeds and then stays fast, so a
// network failure is retried until NETWORK_RETRY_MS has passed (at most ~4
// attempts), keeping a handler run under its ~30 s limit.
// A 429 is retried once after `retry_after`. The runtime has no timers, so
// without one only short waits (≤ 2 s) are retried, relying on Bale's own
// round-trip time as the pause.
export async function baleCall(method, params, files) {
  const started = Date.now();
  let r = await rawCall(method, params, files);
  while (!r.ok && r.network && Date.now() - started < NETWORK_RETRY_MS) {
    r = await rawCall(method, params, files);
  }
  if (!r.ok && r.error_code === 429) {
    const wait = Number(r.parameters && r.parameters.retry_after) || 1;
    if (wait <= MAX_RETRY_WAIT_SECONDS && ((await sleep(wait * 1000)) || wait <= 2)) {
      r = await rawCall(method, params, files);
    }
  }
  return r;
}

// A single attempt, no retries — for callers that manage their own.
export async function baleCallOnce(method, params, files) {
  return rawCall(method, params, files);
}

// Sorts a failed call into a reason the bot can explain.
export function classifyError(r) {
  if (r.ok) return null;
  const code = r.error_code;
  const desc = String(r.description || '').toLowerCase();
  if (r.network || code === 0 || code >= 500) return 'unavailable';
  if (code === 401 || code === 404) return 'auth';
  if (code === 429) return 'rate';
  if (code === 413 || desc.includes('too large') || desc.includes('too big')) return 'too_large';
  if (code === 403 || desc.includes('chat not found') || desc.includes('blocked') || desc.includes('forbidden')) {
    return 'chat';
  }
  return 'rejected';
}

// An error's name and message with the Bale token redacted, for logs.
export function safeErrorText(e) {
  const text = e ? `${e.name || 'Error'}: ${e.description || e.message || ''}` : 'unknown error';
  return BALE_BOT_TOKEN ? text.split(BALE_BOT_TOKEN).join('<redacted>') : text;
}

// Errors that mean Bale itself (or our setup) is broken, not one user's chat.
export function isSystemError(reason) {
  return reason === 'unavailable' || reason === 'auth' || reason === 'rate';
}
