// The Cloudflare relay (relay/worker.js). Telegram Serverless can't connect
// to Eitaa and reaches Bale only now and then; the relay can reach both.
// Each request is signed (ECDSA P-256 over "<unix time>\n<path>") with
// EITAA_RELAY_KEY; the Worker holds only the public key.

import * as CONFIG from './config.js';
import { now, toBase64, fromBase64, utf8Encode } from './util.js';
import { privateScalarFromPkcs8, signP256 } from './p256.js';

export const RELAY_URL = String(CONFIG.EITAA_RELAY_URL || '').replace(/\/+$/, '');
const RELAY_KEY = String(CONFIG.EITAA_RELAY_KEY || '');

export function relayEnabled() {
  return Boolean(RELAY_URL && RELAY_KEY);
}

let relayScalar = null;

// Headers proving the request (for the relay path `path`) comes from this bot.
export async function relayHeaders(path) {
  if (!relayScalar) relayScalar = privateScalarFromPkcs8(fromBase64(RELAY_KEY));
  if (!relayScalar) throw new Error('relay: bad EITAA_RELAY_KEY');
  const ts = String(now());
  const sig = await signP256(relayScalar, utf8Encode(ts + '\n' + path));
  return { 'x-relay-ts': ts, 'x-relay-sig': toBase64(sig) };
}
