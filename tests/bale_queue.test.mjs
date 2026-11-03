import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { db } from 'sdk';

// A real (in-memory) SQLite behind the stubbed sdk `db`, for the raw `sql`
// queries the mirror queue uses.
const sqlite = new DatabaseSync(':memory:');
sqlite.exec(`
  CREATE TABLE delivered (chat_id INTEGER, message_id INTEGER, created_at INTEGER);
  CREATE UNIQUE INDEX uidx_delivered_msg ON delivered (chat_id, message_id);
  CREATE TABLE outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, tg_channel_id INTEGER, sort_key INTEGER, kind TEXT,
    payload TEXT, attempts INTEGER DEFAULT 0, last_reason TEXT, alerted INTEGER DEFAULT 0, created_at INTEGER);`);
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
db.get = async (q) => { const [t, p] = build(q); return sqlite.prepare(t).get(...p) || null; };
db.all = async (q) => { const [t, p] = build(q); return sqlite.prepare(t).all(...p); };
// Like the platform: a statement with RETURNING gives its rows back.
db.run = async (q) => {
  const [t, p] = build(q);
  const st = sqlite.prepare(t);
  if (/\bRETURNING\b/i.test(t)) { const rows = st.all(...p); return { rowsAffected: rows.length, rows }; }
  const r = st.run(...p);
  return { rowsAffected: Number(r.changes), rows: [] };
};

const { enqueuePost } = await import('../tgcloud/lib/mirror.js');
const post = (id) => ({ message_id: id, chat: { id: -100, type: 'channel' }, text: 'تست' });

test('a post delivered twice at the same moment is queued once (seen live: 26 posts became 36)', async () => {
  const deliveries = [];
  for (let i = 0; i < 26; i++) deliveries.push(enqueuePost(-100, post(100 + i)), enqueuePost(-100, post(100 + i)));
  const results = await Promise.all(deliveries);
  assert.ok(results.every(Boolean));
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM outbox').get().n, 26);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM (SELECT sort_key FROM outbox GROUP BY sort_key HAVING count(*) > 1)').get().n, 0);
});

test('a redelivery later is ignored too', async () => {
  await enqueuePost(-100, post(500));
  await enqueuePost(-100, post(500));
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM outbox WHERE sort_key = 500').get().n, 1);
});
