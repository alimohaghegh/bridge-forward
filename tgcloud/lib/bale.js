// Minimal client for the Bale Bot API (https://docs.bale.ai).
// Never log the request URL: it contains the bot token.
//
// From Telegram Serverless, most new connections to Bale time out (~5 s);
// through the Cloudflare relay (lib/relay.js) they are fast. So calls go
// through the relay when it is configured, and attempts alternate between
// the relay and the direct route, so either one failing is survived.

import { fetch, FormData, db } from 'sdk';
import { sql } from 'sdk/db';
import { BALE_BOT_TOKEN } from './config.js';
import { sleep } from './util.js';
import { RELAY_URL, relayEnabled, relayHeaders } from './relay.js';

const DIRECT = 'https://tapi.bale.ai';
const MAX_RETRY_WAIT_SECONDS = 10;
const NETWORK_RETRY_MS = 15500;

async function rawCall(method, params, files, viaRelay) {
  const path = '/bot' + BALE_BOT_TOKEN + '/' + method;
  const url = viaRelay ? RELAY_URL + '/bale' + path : DIRECT + path;
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
    const init = { method: 'POST', body };
    if (viaRelay) init.headers = await relayHeaders('/bale' + path);
    res = await fetch(url, init);
  } catch (e) {
    const detail = safeErrorText(e);
    console.warn('bale: network error on', method, viaRelay ? '(relay)' : '(direct)', detail);
    return { ok: false, error_code: 0, description: 'network error', network: true, detail, via: viaRelay ? 'relay' : 'direct' };
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  const via = viaRelay ? 'relay' : 'direct';
  if (!data || typeof data.ok !== 'boolean') {
    console.warn('bale: unexpected response on', method, res.status, via);
    return { ok: false, error_code: res.status, description: 'unexpected response', network: res.status >= 500 || viaRelay, via };
  }
  // The relay itself refused or couldn't reach Bale: try the other route.
  if (!data.ok && viaRelay && String(data.description || '').startsWith('relay:')) {
    console.warn('bale:', method, data.description);
    return { ok: false, error_code: 0, description: 'network error', network: true, detail: data.description, via };
  }
  if (!data.ok) console.warn('bale:', method, 'failed with', data.error_code, data.description);
  data.via = via;
  return data;
}

// Calls a Bale method. Returns the raw envelope ({ ok, result } or
// { ok: false, error_code, description, parameters }); never throws.
// A network failure is retried until NETWORK_RETRY_MS has passed (at most
// ~4 attempts, keeping a handler run under its ~30 s limit), alternating
// relay and direct when the relay is configured (relay first).
// A 429 is retried once after `retry_after`. The runtime has no timers, so
// without one only short waits (≤ 2 s) are retried, relying on Bale's own
// round-trip time as the pause.
// Attempts of methods that change something are logged (bale_calls).
const LOGGED = /^(send|edit|delete|forward|copy)/;

async function logged(callId, attempt, method, params, files, viaRelay) {
  const t = Date.now();
  const r = await rawCall(method, params, files, viaRelay);
  if (LOGGED.test(method)) {
    try {
      await db.run(sql`
        INSERT INTO bale_calls (at_ms, call_id, attempt, method, ms, via, ok, network, code)
        VALUES (${t}, ${callId}, ${attempt}, ${method}, ${Date.now() - t}, ${r.via || null}, ${r.ok ? 1 : 0}, ${r.network ? 1 : 0}, ${r.error_code || null})`);
      if (Math.random() < 0.05) await db.run(sql`DELETE FROM bale_calls WHERE id < (SELECT max(id) - 400 FROM bale_calls)`);
    } catch {
      // Diagnosis only.
    }
  }
  return r;
}

export async function baleCall(method, params, files) {
  const started = Date.now();
  const relay = relayEnabled();
  const callId = Math.random().toString(36).slice(2, 8);
  let attempt = 0;
  let r = await logged(callId, 0, method, params, files, relay);
  while (!r.ok && r.network && Date.now() - started < NETWORK_RETRY_MS) {
    attempt++;
    r = await logged(callId, attempt, method, params, files, relay && attempt % 2 === 0);
  }
  if (!r.ok && r.error_code === 429) {
    const wait = Number(r.parameters && r.parameters.retry_after) || 1;
    if (wait <= MAX_RETRY_WAIT_SECONDS && ((await sleep(wait * 1000)) || wait <= 2)) {
      r = await logged(callId, attempt + 1, method, params, files, relay);
    }
  }
  return r;
}

let onceCount = 0;

// A single attempt, no retries — for callers that manage their own. Calls
// alternate relay / direct (relay first) so a retry loop uses both.
export async function baleCallOnce(method, params, files) {
  return rawCall(method, params, files, relayEnabled() && onceCount++ % 2 === 0);
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
