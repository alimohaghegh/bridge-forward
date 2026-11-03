import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';
import { db } from 'sdk';

// Album collection on machines whose clocks disagree with the database's
// (measured live: one ~99 s ahead, another ~96 s behind). Before the fix an
// album was "rescued" as stale while still being collected and reached Bale
// in pieces, out of order.
const sqlite = new DatabaseSync(':memory:');
sqlite.exec(`
  CREATE TABLE albums (key TEXT PRIMARY KEY, created_ms INTEGER NOT NULL, closed INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE album_items (key TEXT NOT NULL, chat_id INTEGER NOT NULL, message_id INTEGER NOT NULL,
    created_ms INTEGER NOT NULL, taken INTEGER NOT NULL DEFAULT 0, item TEXT NOT NULL);
  CREATE UNIQUE INDEX uidx_album_items_msg ON album_items (chat_id, message_id);`);
const build = (q) => {
  let text = '';
  const params = [];
  const walk = (x) => x.s.forEach((part, i) => {
    text += part;
    if (i >= x.v.length) return;
    const v = x.v[i];
    if (v && v.raw !== undefined) text += v.raw;
    else if (v && v.s) walk(v);
    else { text += '?'; params.push(typeof v === 'boolean' ? Number(v) : v === undefined ? null : v); }
  });
  walk(q);
  return [text, params];
};
// Each call yields to the event loop, like a real database round trip.
const tick = () => new Promise((r) => setImmediate(r));
db.get = async (q) => { await tick(); const [t, p] = build(q); return sqlite.prepare(t).get(...p) || null; };
db.all = async (q) => { await tick(); const [t, p] = build(q); return sqlite.prepare(t).all(...p); };
db.run = async (q) => {
  await tick();
  const [t, p] = build(q);
  const st = sqlite.prepare(t);
  if (/\bRETURNING\b/i.test(t)) { const rows = st.all(...p); return { rowsAffected: rows.length, rows }; }
  const r = st.run(...p);
  return { rowsAffected: Number(r.changes), rows: [] };
};

const { collectAlbum, takeStaleAlbums } = await import('../tgcloud/lib/album.js');
const photo = (id) => ({
  message_id: id, media_group_id: 'g1', chat: { id: -100, type: 'channel' },
  photo: [{ file_id: 'f' + id, file_unique_id: 'u' + id, width: 10, height: 10, file_size: 100 }],
});

// Each run sees its own machine's clock (async context), like the platform.
const machine = new AsyncLocalStorage();
const realNow = Date.now;
Date.now = () => realNow() + (machine.getStore() || 0);
const on = (skewMs, fn) => machine.run(skewMs, fn);

test('an album stays whole and in order when machines\' clocks disagree by ~100 s', async () => {
  // Items arrive in mixed order on machines 0 s and 96 s behind; meanwhile
  // the scheduled run, on a machine 99 s ahead, looks for stuck albums
  // (older than 30 s).
  const runs = [
    on(0, () => collectAlbum(photo(12))),
    on(-96000, () => collectAlbum(photo(11))),
    on(-96000, () => collectAlbum(photo(13))),
  ];
  await new Promise((r) => setTimeout(r, 300));
  const stale = await on(99000, () => takeStaleAlbums(-100, 30 * 1000));
  const [leader, ...others] = await Promise.all(runs);
  assert.deepEqual(stale, []);
  assert.deepEqual(others, [null, null]);
  assert.deepEqual(leader.map((it) => it.tg), [11, 12, 13]);
});
