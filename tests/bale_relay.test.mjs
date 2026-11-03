import { test } from 'node:test';
import assert from 'node:assert/strict';

const c = globalThis.crypto;
const kp = await c.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
globalThis.__testConfig = {
  BALE_BOT_TOKEN: '123:abc',
  EITAA_RELAY_URL: 'https://relay.test',
  EITAA_RELAY_KEY: Buffer.from(await c.subtle.exportKey('pkcs8', kp.privateKey)).toString('base64'),
};
const { baleCall } = await import('../tgcloud/lib/bale.js');

const json = (body) => ({ status: 200, json: async () => body });

test('Bale goes through the relay first, signed for the path the Worker checks', async () => {
  const seen = [];
  globalThis.__testFetch = async (url, init) => {
    seen.push(url);
    const path = new URL(url).pathname;
    const ok = await c.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, kp.publicKey,
      Buffer.from(init.headers['x-relay-sig'], 'base64'), new TextEncoder().encode(init.headers['x-relay-ts'] + '\n' + path));
    assert.equal(ok, true);
    return json({ ok: true, result: { id: 1 } });
  };
  const r = await baleCall('getMe', {});
  assert.equal(r.ok, true);
  assert.equal(r.via, 'relay');
  assert.deepEqual(seen, ['https://relay.test/bale/bot123:abc/getMe']);
});

test('relay down: the next attempt goes direct', async () => {
  const seen = [];
  globalThis.__testFetch = async (url) => {
    seen.push(url);
    if (url.startsWith('https://relay.test')) throw new Error('fetch: request failed');
    return json({ ok: true, result: { id: 1 } });
  };
  const r = await baleCall('getMe', {});
  assert.equal(r.ok, true);
  assert.equal(r.via, 'direct');
  assert.deepEqual(seen, ['https://relay.test/bale/bot123:abc/getMe', 'https://tapi.bale.ai/bot123:abc/getMe']);
});

test('relay refusing (e.g. bad signature) counts as a network failure, not as Bale refusing', async () => {
  const seen = [];
  globalThis.__testFetch = async (url) => {
    seen.push(url);
    if (url.startsWith('https://relay.test')) return json({ ok: false, description: 'relay: bad signature' });
    return json({ ok: true, result: { message_id: 7 } });
  };
  const r = await baleCall('sendMessage', { chat_id: 1, text: 'x' });
  assert.equal(r.ok, true);
  assert.equal(seen.length, 2);
});

test('a real Bale refusal through the relay is returned as is (no pointless retry)', async () => {
  let n = 0;
  globalThis.__testFetch = async () => {
    n++;
    return json({ ok: false, error_code: 403, description: 'Forbidden: bot is not a member' });
  };
  const r = await baleCall('sendMessage', { chat_id: 1, text: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.error_code, 403);
  assert.equal(n, 1);
});
