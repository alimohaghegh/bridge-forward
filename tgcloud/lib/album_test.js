// Live album test (CI `album.yml`): numbered photos sent as albums of a fake
// channel, each item in its own run and in shuffled order, like Telegram's
// updates. Mirrored into the owner's own Bale chat; the report shows that
// each album arrived whole, and what Bale's answer to an album lists at each
// place (Bale's forwards carry no photo, so nothing else can be read back).
// Outputs hold counts and numbers only.

import { api, db, InputFile } from 'sdk';
import { sql } from 'sdk/db';
import { baleCall } from './bale.js';
import { saveChannel } from './channels.js';
import { OWNER_TELEGRAM_ID } from './config.js';
import { getSetting, setSetting } from './eitaa.js';
import { getUser } from './store.js';
import { DB_NOW_MS, rowsOf } from './util.js';

const CHANNEL = -43;
const ALBUMS = 3;
const ITEMS = 6;

function crc32(bytes) {
  let c = ~0;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return ~c >>> 0;
}

const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

function pngChunk(type, data) {
  const body = [...type].map((ch) => ch.charCodeAt(0)).concat(data);
  return [...be32(data.length), ...body, ...be32(crc32(body))];
}

// Photo n's size tells it apart when read back from Bale.
const sideOf = (n) => 80 + n * 10;

// A one-colour PNG, uncompressed (a single stored deflate block).
export function testPng(n) {
  const side = sideOf(n);
  const row = [0];
  for (let x = 0; x < side; x++) row.push((n * 40) % 256, 255 - n * 30, 90);
  const raw = [];
  for (let y = 0; y < side; y++) raw.push(...row);
  let a = 1;
  let b = 0;
  for (const v of raw) {
    a = (a + v) % 65521;
    b = (b + a) % 65521;
  }
  const len = raw.length;
  const zlib = [0x78, 0x01, 0x01, len & 255, len >> 8, ~len & 255, (~len >> 8) & 255, ...raw, ...be32(((b << 16) | a) >>> 0)];
  return new Uint8Array([
    137, 80, 78, 71, 13, 10, 26, 10,
    ...pngChunk('IHDR', [...be32(side), ...be32(side), 8, 2, 0, 0, 0]),
    ...pngChunk('IDAT', zlib),
    ...pngChunk('IEND', []),
  ]);
}

async function clearState() {
  await db.run(sql`DELETE FROM outbox WHERE tg_channel_id = ${CHANNEL}`);
  await db.run(sql`DELETE FROM mirrored WHERE tg_chat_id = ${CHANNEL}`);
  await db.run(sql`DELETE FROM delivered WHERE chat_id = ${CHANNEL}`);
  await db.run(sql`DELETE FROM album_items WHERE chat_id = ${CHANNEL}`);
  await db.run(sql`DELETE FROM albums WHERE key LIKE ${CHANNEL + ':%'}`);
  await db.run(sql`DELETE FROM debug_events WHERE kind = 'album_item'`);
  await db.run(sql`DELETE FROM channels WHERE tg_channel_id = ${CHANNEL}`);
}

export async function runAlbumPrepare() {
  const owner = await getUser(OWNER_TELEGRAM_ID);
  if (!owner || !owner.baleChatId) return { ok: false, error: 'owner not linked' };
  await clearState();
  await saveChannel(CHANNEL, owner.baleChatId, OWNER_TELEGRAM_ID);
  // file_ids come from sending each photo to the owner, removed at once.
  const photos = [];
  for (let i = 1; i <= ITEMS; i++) {
    const m = await api.sendPhoto({
      chat_id: OWNER_TELEGRAM_ID, disable_notification: true,
      photo: new InputFile(testPng(i), `${i}.png`, { type: 'image/png' }),
    });
    photos.push(m.photo[m.photo.length - 1]);
    await api.deleteMessage({ chat_id: OWNER_TELEGRAM_ID, message_id: m.message_id }).catch(() => null);
  }
  const last = await db.get(sql`SELECT max(id) AS id FROM bale_calls`);
  const base = Math.floor(Date.now() / 1000) * 1000;
  await setSetting('album_test', { photos, base, run: base.toString(36), fromCallId: Number(last && last.id) || 0 });
  return { ok: true, photos: photos.length };
}

const messageId = (st, album, item) => st.base + album * 20 + item;

// The channel post of `item` in `album` (1-based); its caption is its number.
export async function albumTestPost({ album, item }) {
  const st = await getSetting('album_test', null);
  await db.run(sql`INSERT INTO debug_events (at_ms, kind, key, run_id) VALUES (${DB_NOW_MS}, 'album_item', ${album}, ${String(Date.now())})`);
  return {
    message_id: messageId(st, album, item), date: Math.floor(st.base / 1000), media_group_id: `${st.run}-${album}`,
    chat: { id: CHANNEL, type: 'channel' }, photo: [st.photos[item - 1]], caption: String(item),
  };
}

// Sends the photos as one album, numbered in order, and returns what Bale's
// own answer lists at each place. Removed at once.
async function baleKeepsOrder(chat, photos) {
  const media = [];
  const uploads = {};
  for (let i = 0; i < photos.length; i++) {
    media.push({ type: 'photo', media: `attach://file${i}`, caption: String(i + 1) });
    uploads[`file${i}`] = new InputFile(await api.getFileContent(photos[i].file_id), 'photo.jpg', { type: 'image/jpeg' });
  }
  const r = await baleCall('sendMediaGroup', { chat_id: chat, media }, uploads);
  if (!r.ok) return { error: r.error_code };
  const list = Array.isArray(r.result) ? r.result : [];
  const ids = list.map((m) => m.message_id);
  const seen = list.map((m) => {
    const w = m.photo && m.photo.length ? Math.max(...m.photo.map((x) => Number(x.width) || 0)) : 0;
    return `${m.caption ?? '-'}/${w}`;
  });
  for (const id of ids) await baleCall('deleteMessage', { chat_id: chat, message_id: id });
  return { seen: seen.join(' '), idsAscending: ids.every((id, i) => i === 0 || id > ids[i - 1]), keys: Object.keys(list[0] || {}).join('+') };
}

export async function runAlbumReport() {
  const owner = await getUser(OWNER_TELEGRAM_ID);
  const st = await getSetting('album_test', null);
  if (!owner || !st) return { ok: false, error: 'not prepared' };
  const chat = owner.baleChatId;
  const calls = {};
  for (const c of rowsOf(await db.all(sql`
    SELECT method, sum(CASE WHEN ok = 1 THEN 1 ELSE 0 END) AS ok FROM bale_calls
    WHERE chat_id = ${chat} AND id > ${st.fromCallId} GROUP BY method`))) calls[c.method] = c.ok;
  const left = await db.get(sql`SELECT count(*) AS n FROM outbox WHERE tg_channel_id = ${CHANNEL}`);
  const events = rowsOf(await db.all(sql`SELECT at_ms, key, run_id FROM debug_events WHERE kind = 'album_item'`));
  const mirrored = rowsOf(await db.all(sql`
    SELECT tg_message_id, bale_ids FROM mirrored WHERE tg_chat_id = ${CHANNEL} ORDER BY tg_message_id`));

  const albums = [];
  for (let a = 1; a <= ALBUMS; a++) {
    const rows = mirrored.filter((r) => {
      const n = Number(r.tg_message_id);
      return n > messageId(st, a, 0) && n <= messageId(st, a, ITEMS);
    });
    const ids = rows.map((r) => JSON.parse(r.bale_ids)[0]);
    const mine = events.filter((e) => Number(e.key) === a);
    const times = mine.map((e) => Number(e.at_ms));
    const local = mine.map((e) => Number(e.run_id));
    albums.push({
      arrived: times.length, spreadMs: times.length ? Math.max(...times) - Math.min(...times) : null,
      localSpreadMs: local.length ? Math.max(...local) - Math.min(...local) : null,
      mirrored: rows.length, idsAscending: ids.every((id, i) => i === 0 || id > ids[i - 1]),
    });
  }
  const baleOrder = [];
  for (let k = 0; k < 3; k++) baleOrder.push(await baleKeepsOrder(chat, st.photos));
  return { ok: true, baleOrder, sendMediaGroup: calls.sendMediaGroup || 0, sendPhoto: calls.sendPhoto || 0, queueLeft: left.n, albums };
}

export async function runAlbumCleanup() {
  const owner = await getUser(OWNER_TELEGRAM_ID);
  let deleted = 0;
  const rows = rowsOf(await db.all(sql`SELECT bale_ids FROM mirrored WHERE tg_chat_id = ${CHANNEL}`));
  for (const r of rows) {
    for (const id of JSON.parse(r.bale_ids)) {
      const d = await baleCall('deleteMessage', { chat_id: owner.baleChatId, message_id: id });
      if (d.ok) deleted++;
    }
  }
  await clearState();
  return { ok: true, deleted };
}
