// Collects album items (one update each) and sends them as one Bale album.
//
// The first item's run becomes the leader: it waits until no new item has
// arrived for QUIET_MS (the platform has no timers, so it polls the
// database), then closes the album and sends every collected item. Items
// that arrive after the album was closed are sent on their own.

import { db } from 'sdk';
import { sql } from 'sdk/db';
import { albumItemOf, deliverAlbum, deliver } from './forward.js';
import { rowsOf } from './util.js';

const QUIET_MS = 1800;
const MAX_WAIT_MS = 6000;
const MAX_ITEMS = 10;
const RETENTION_MS = 10 * 60 * 1000;

// Delivers a message; album items are collected first. Returns null when
// this run has nothing more to do (another run sends the item), or
// { ok, reason?, messageIds } for the messages this run delivered.
export async function deliverMessage(baleChatId, m) {
  const item = m.media_group_id ? albumItemOf(m) : null;
  if (!item) {
    const r = await deliver(baleChatId, m);
    return { ...r, messageIds: [m.message_id] };
  }
  const key = `${m.chat.id}:${m.media_group_id}`;
  const t = Date.now();

  await db.run(sql`
    INSERT OR IGNORE INTO album_items (key, chat_id, message_id, created_ms, item)
    VALUES (${key}, ${m.chat.id}, ${m.message_id}, ${t}, ${JSON.stringify(item)})`);
  const leader = (await db.run(sql`
    INSERT OR IGNORE INTO albums (key, created_ms) VALUES (${key}, ${t})`)).rowsAffected > 0;

  if (!leader) {
    const album = await db.get(sql`SELECT closed FROM albums WHERE key = ${key}`);
    if (!album || !album.closed) return null; // the leader will send it
    // Arrived too late for the album: send it alone, unless the leader got it.
    const mine = rowsOf(await db.run(sql`
      UPDATE album_items SET taken = 1
      WHERE chat_id = ${m.chat.id} AND message_id = ${m.message_id} AND taken = 0
      RETURNING item`));
    if (!mine.length) return null;
    await db.run(sql`DELETE FROM album_items WHERE chat_id = ${m.chat.id} AND message_id = ${m.message_id}`);
    const r = await deliverAlbum(baleChatId, [item]);
    return { ...r, messageIds: [m.message_id] };
  }

  // Leader: wait for the rest of the album.
  while (Date.now() - t < MAX_WAIT_MS) {
    const s = await db.get(sql`
      SELECT count(*) AS n, max(created_ms) AS last FROM album_items WHERE key = ${key}`);
    if (s.n >= MAX_ITEMS || Date.now() - s.last >= QUIET_MS) break;
  }

  await db.run(sql`UPDATE albums SET closed = 1 WHERE key = ${key}`);
  const rows = rowsOf(await db.run(sql`
    UPDATE album_items SET taken = 1 WHERE key = ${key} AND taken = 0 RETURNING item`));
  await db.run(sql`DELETE FROM album_items WHERE key = ${key} AND taken = 1`);

  const items = rows.map((row) => JSON.parse(row.item));
  const r = await deliverAlbum(baleChatId, items);
  return { ...r, messageIds: items.map((it) => it.messageId) };
}

// Drops leftovers of albums that were never sent (e.g. a run was cut off).
export async function cleanupAlbums() {
  const cutoff = Date.now() - RETENTION_MS;
  await db.run(sql`DELETE FROM album_items WHERE created_ms < ${cutoff}`);
  await db.run(sql`DELETE FROM albums WHERE created_ms < ${cutoff}`);
}
