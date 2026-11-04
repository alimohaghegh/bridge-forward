import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api } from 'sdk';

globalThis.__testConfig = { BALE_BOT_TOKEN: '123:abc' };
const { planAlbum, runPlan, albumItemOf } = await import('../tgcloud/lib/forward.js');

api.getFileContent = async () => new Uint8Array([1]);
const json = (body) => ({ status: 200, json: async () => body });
const item = (id, caption) => albumItemOf({ message_id: id, photo: [{ file_id: 'tg' + id, file_size: 10 }], caption });

// A Bale stand-in; `refuse` names the upload number (1-based) that fails.
function bale({ refuse, noFileId } = {}) {
  const calls = [];
  let uploads = 0;
  globalThis.__testFetch = async (url, init) => {
    const method = url.split('/').pop();
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : Object.fromEntries(init.body.fields);
    calls.push({ method, body });
    if (method === 'getMe') return json({ ok: true, result: { id: 77 } });
    if (method === 'sendPhoto') {
      uploads++;
      if (uploads === refuse) return json({ ok: false, error_code: 400, description: 'no' });
      const photo = noFileId ? undefined : [{ file_id: 'small' }, { file_id: 'bale' + uploads }];
      return json({ ok: true, result: { message_id: 500 + uploads, photo } });
    }
    if (method === 'sendMediaGroup') {
      const media = typeof body.media === 'string' ? JSON.parse(body.media) : body.media;
      return json({ ok: true, result: media.map((_, i) => ({ message_id: 900 + i })) });
    }
    return json({ ok: true, result: true });
  };
  return calls;
}

const album = (calls) => {
  const c = calls.find((x) => x.method === 'sendMediaGroup');
  return { ...c, media: typeof c.body.media === 'string' ? JSON.parse(c.body.media) : c.body.media };
};

test('an album names files already on Bale, in order, and the uploads are removed', async () => {
  const calls = bale();
  const plan = planAlbum([item(3), item(1, 'کپشن'), item(2)]);
  assert.equal((await runPlan(-5, plan)).ok, true);

  assert.deepEqual(album(calls).media.map((m) => m.media), ['bale1', 'bale2', 'bale3']);
  assert.equal(album(calls).media[0].caption, 'کپشن');
  assert.equal(album(calls).body.chat_id, -5);
  for (const c of calls.filter((x) => x.method === 'sendPhoto')) assert.equal(c.body.chat_id, '77');
  const removed = calls.filter((x) => x.method === 'deleteMessage');
  assert.deepEqual(removed.map((c) => c.body.message_id), [501, 502, 503]);
  assert.ok(removed.every((c) => c.body.chat_id === 77));
  assert.deepEqual(plan.ids, { 1: [900], 2: [901], 3: [902] });
});

test('when an upload fails, the rest go with the album and nothing is lost', async () => {
  const calls = bale({ refuse: 2 });
  assert.equal((await runPlan(-5, planAlbum([item(1), item(2), item(3)]))).ok, true);
  assert.deepEqual(album(calls).media.map((m) => m.media), ['bale1', 'attach://file1', 'attach://file2']);
  assert.equal(calls.filter((x) => x.method === 'sendPhoto').length, 2);
  assert.deepEqual(calls.filter((x) => x.method === 'deleteMessage').map((c) => c.body.message_id), [501]);
});

test('an upload answered without a file id is removed and the file goes with the album', async () => {
  const calls = bale({ noFileId: true });
  assert.equal((await runPlan(-5, planAlbum([item(1), item(2)]))).ok, true);
  assert.deepEqual(album(calls).media.map((m) => m.media), ['attach://file0', 'attach://file1']);
  assert.equal(calls.filter((x) => x.method === 'deleteMessage').length, 2);
});
