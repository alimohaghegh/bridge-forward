// Collects album items (one update each) so they can be sent as one album.
//
// The first item's run becomes the leader: it waits until no new item has
// arrived for QUIET_MS (the platform has no timers, so it polls the
// database), then closes the album and takes every collected item. Items
// that arrive after the album was closed are taken by their own run.
// Taken rows stay until the caller releases them, so a channel's queue
// never overtakes an album that is being handed over.

import { db } from 'sdk';
import { sql } from 'sdk/db';
import { albumItemOf } from './forward.js';
import { rowsOf } from './util.js';

const QUIET_MS = 1800;
const MAX_WAIT_MS = 6000;
const MAX_ITEMS = 10;
const RETENTION_MS = 10 * 60 * 1000;

export function isAlbumItem(m) {
  return Boolean(m.media_group_id && albumItemOf(m));
}

// Returns null when another run takes this item, else the items this run
// must send (sorted). Call releaseAlbumItems afterwards.
export async function collectAlbum(m) {
  const item = albumItemOf(m);
  const chatId = m.chat.id;
  const key = `${chatId}:${m.media_group_id}`;
  const t = Date.now();

  await db.run(sql`
    INSERT OR IGNORE INTO album_items (key, chat_id, message_id, created_ms, item)
    VALUES (${key}, ${chatId}, ${m.message_id}, ${t}, ${JSON.stringify(item)})`);
  const leader = (await db.run(sql`
    INSERT OR IGNORE INTO albums (key, created_ms) VALUES (${key}, ${t})`)).rowsAffected > 0;

  if (!leader) {
    const album = await db.get(sql`SELECT closed FROM albums WHERE key = ${key}`);
    if (!album || !album.closed) return null; // the leader takes it
    // Arrived too late for the album: take it alone, unless the leader did.
    const mine = rowsOf(await db.run(sql`
      UPDATE album_items SET taken = 1
      WHERE chat_id = ${chatId} AND message_id = ${m.message_id} AND taken = 0
      RETURNING item`));
    return mine.length ? [item] : null;
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
  return rows.map((row) => JSON.parse(row.item)).sort((a, b) => a.tg - b.tg);
}

export async function releaseAlbumItems(chatId, items) {
  for (const it of items) {
    await db.run(sql`DELETE FROM album_items WHERE chat_id = ${chatId} AND message_id = ${it.tg}`);
  }
}

// Album items of `chatId` left behind by a run that was cut off (older than
// `olderThanMs`), taken and grouped per album: [[items], …].
export async function takeStaleAlbums(chatId, olderThanMs) {
  const cutoff = Date.now() - olderThanMs;
  const rows = rowsOf(await db.run(sql`
    UPDATE album_items SET taken = 1
    WHERE chat_id = ${chatId} AND created_ms < ${cutoff}
    RETURNING key, item`));
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.key)) groups.set(row.key, []);
    groups.get(row.key).push(JSON.parse(row.item));
    await db.run(sql`UPDATE albums SET closed = 1 WHERE key = ${row.key}`);
  }
  return [...groups.values()].map((items) => items.sort((a, b) => a.tg - b.tg));
}

// True while album items of `chatId` older than message `beforeTg` are
// still being collected or handed over.
export async function albumPending(chatId, beforeTg) {
  const row = await db.get(sql`
    SELECT 1 AS x FROM album_items WHERE chat_id = ${chatId} AND message_id < ${beforeTg} LIMIT 1`);
  return Boolean(row);
}

// Drops leftovers of private-chat albums that were never sent (a run was
// cut off). Channel albums are never dropped: the mirror queue rescues them.
export async function cleanupAlbums() {
  const cutoff = Date.now() - RETENTION_MS;
  await db.run(sql`DELETE FROM album_items WHERE chat_id > 0 AND created_ms < ${cutoff}`);
  await db.run(sql`
    DELETE FROM albums WHERE created_ms < ${cutoff}
      AND NOT EXISTS (SELECT 1 FROM album_items i WHERE i.key = albums.key)`);
}
