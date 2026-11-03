import { test } from 'node:test';
import assert from 'node:assert/strict';
import { privateScalarFromPkcs8, signP256 } from '../tgcloud/lib/p256.js';

test('pure-JS P-256 signatures verify with WebCrypto; tampering fails', async () => {
  const c = globalThis.crypto;
  const kp = await c.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const d = privateScalarFromPkcs8(new Uint8Array(await c.subtle.exportKey('pkcs8', kp.privateKey)));
  assert.ok(d);
  for (let i = 0; i < 10; i++) {
    const msg = new TextEncoder().encode(`${1700000000 + i}\n/api/bot1:x/sendMessage`);
    const sig = await signP256(d, msg);
    assert.equal(await c.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, kp.publicKey, sig, msg), true);
    const bad = sig.slice();
    bad[3] ^= 1;
    assert.equal(await c.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, kp.publicKey, bad, msg), false);
  }
});
