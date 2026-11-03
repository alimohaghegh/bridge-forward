// Telegram channel → Eitaa channel mirroring through EitaaYar.
//
// Each post gets a row in eitaa_posts (ids and outcome only). Posts are sent
// one at a time per channel, in Telegram order (a lock on eitaa_channels).
// A post that can't be sent now stays `queued`; when it is retried (next
// channel activity, «تلاش دوباره», or the scheduled run) its content is read
// back from Telegram by forwarding it to the channel owner's chat with the
// bot and deleting that copy at once — so post contents are never stored.
//
// EitaaYar can only send (sendMessage / sendFile, one file per post): no
// albums, edits or deletions unless /eitaa_diag methods found (and the bot
// owner confirmed) a working method. Edits and deletions are otherwise
// reported to the channel owner with the post's panel title tg-<id>.
// Deleted posts are found by probing: editMessageReplyMarkup on a channel
// post the bot didn't write answers "message can't be edited" while it
// exists and "message to edit not found" once it is gone (nothing changes).

import { api, db, InputFile, BotApiError } from 'sdk';
import { sql } from 'sdk/db';
import {
  eitaaCall, classifyEitaa, isTemporary, messageIdOf, eitaaCaps, channelToken, describeFailure,
} from './eitaa.js';
import { toEitaaChunks, toEitaaCaption, escapeText } from './eitaa_html.js';
import { MAX_FILE_BYTES, now, rowsOf, sleep } from './util.js';
import { E } from './texts.js';

const LOCK_SECONDS = 40;
const LOCK_WAIT_MS = 9000;
const MAX_ATTEMPTS = 8;
const ALERT_AFTER_ATTEMPTS = 2;
const PROBE_INTERVAL_SECONDS = 60;
const PROBE_LAST_N = 20;
const PROBE_WINDOW_SECONDS = 60 * 24 * 3600; // the EitaaYar panel keeps posts 2 months
const RETENTION_SECONDS = 62 * 24 * 3600;
const RETRY_WAIT_MAX_SECONDS = 3;

// Issues worth a message to the channel owner (the rest show in «گزارش»).
const NOTIFY_ISSUES = new Set(['too_large', 'unsupported', 'sticker', 'poll', 'protected']);

// ── Channels ────────────────────────────────────────────────────────────────

export async function getEitaaChannel(tgChannelId) {
  const row = await db.get(sql`SELECT * FROM eitaa_channels WHERE tg_channel_id = ${tgChannelId}`);
  return row ? channelRow(row) : null;
}

export function channelRow(r) {
  return {
    tgChannelId: Number(r.tg_channel_id), ownerTgId: Number(r.owner_tg_id), mode: r.mode, status: r.status,
    eitaaChatId: r.eitaa_chat_id, tokenEnc: r.token_enc, albumPolicy: r.album_policy || 'skip',
    notifyEdits: Boolean(r.notify_edits), stopReason: r.stop_reason, alerted: Boolean(r.alerted),
    sentCount: r.sent_count, partialCount: r.partial_count, failedCount: r.failed_count,
  };
}

async function ownerBlocked(ch) {
  const u = await db.get(sql`SELECT blocked FROM users WHERE tg_id = ${ch.ownerTgId}`);
  return Boolean(u && u.blocked);
}

const titles = new Map();

// { title, username } of a Telegram channel, looked up live (not stored).
export async function channelInfo(tgChannelId) {
  if (titles.has(tgChannelId)) return titles.get(tgChannelId);
  let info = { title: String(tgChannelId), username: null };
  try {
    const chat = await api.getChat({ chat_id: tgChannelId });
    info = { title: chat.title || String(tgChannelId), username: chat.username || null };
  } catch {
    // Keep the id as the title.
  }
  titles.set(tgChannelId, info);
  return info;
}

export function postLink(tgChannelId, username, messageId) {
  if (username) return `https://t.me/${username}/${messageId}`;
  return `https://t.me/c/${String(tgChannelId).replace(/^-100/, '')}/${messageId}`;
}

async function tell(chatId, text, extra) {
  try {
    await api.sendMessage({ chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra });
    return true;
  } catch {
    return false;
  }
}

// ── What a post becomes in Eitaa ────────────────────────────────────────────

const CONTENT_KEYS = [
  'text', 'photo', 'video', 'animation', 'audio', 'voice', 'document', 'sticker', 'video_note',
  'location', 'venue', 'contact', 'poll', 'dice', 'game', 'invoice', 'story', 'paid_media',
  'giveaway', 'giveaway_winners', 'checklist',
];

// Service messages (pins, title changes…) have none of these: ignored.
export function hasContent(m) {
  return CONTENT_KEYS.some((k) => m[k] !== undefined && m[k] !== null);
}

function safeName(name, fallback) {
  let s = String(name || '').replace(/[\\/:*?"<>|\r\n\t]/g, '_').trim();
  if (!s) s = fallback;
  if (!/\.[A-Za-z0-9]{1,5}$/.test(s)) s += fallback.slice(fallback.lastIndexOf('.'));
  return s.slice(-100);
}

function asciiName(name) {
  const ext = (name.match(/\.[A-Za-z0-9]{1,5}$/) || ['.bin'])[0];
  return /^[\x20-\x7e]+$/.test(name) ? name : 'file' + ext;
}

const EXT_BY_MIME = { 'application/pdf': '.pdf', 'application/zip': '.zip', 'image/png': '.png', 'image/jpeg': '.jpg', 'audio/mpeg': '.mp3', 'video/mp4': '.mp4' };

// The file to upload for a media post, or null.
export function fileSpecOf(m, issues) {
  const spec = (f, name, mime) => ({ fileId: f.file_id, size: f.file_size || 0, name, mime });
  if (m.photo && m.photo.length) return spec(m.photo[m.photo.length - 1], 'photo.jpg', 'image/jpeg');
  if (m.animation) {
    const a = m.animation;
    // Telegram turns GIFs into MP4: only a real GIF may be named .gif.
    if (a.mime_type === 'image/gif') return spec(a, safeName(a.file_name, 'animation.gif'), 'image/gif');
    issues.add('animation');
    return spec(a, 'animation.mp4', a.mime_type || 'video/mp4');
  }
  if (m.video) return spec(m.video, safeName(m.video.file_name, 'video.mp4'), m.video.mime_type || 'video/mp4');
  if (m.video_note) return spec(m.video_note, 'video_note.mp4', 'video/mp4');
  if (m.voice) return spec(m.voice, 'voice.ogg', m.voice.mime_type || 'audio/ogg');
  if (m.audio) return spec(m.audio, safeName(m.audio.file_name, 'audio.mp3'), m.audio.mime_type || 'audio/mpeg');
  if (m.document) {
    const d = m.document;
    const ext = EXT_BY_MIME[d.mime_type] || '.bin';
    return spec(d, safeName(d.file_name, 'file' + ext), d.mime_type || 'application/octet-stream');
  }
  if (m.sticker) {
    const s = m.sticker;
    if (s.is_animated || s.is_video) return null; // .tgs / .webm: no Eitaa equivalent
    return spec(s, 'sticker.webp', 'image/webp');
  }
  return null;
}

function forwardPrefix(m) {
  const o = m.forward_origin;
  if (!o) return null;
  let name = '';
  const c = o.chat || o.sender_chat;
  if (c) name = (c.title || '') + (c.username ? ` (@${c.username})` : '');
  else if (o.sender_user) name = [o.sender_user.first_name, o.sender_user.last_name].filter(Boolean).join(' ');
  else if (o.sender_user_name) name = o.sender_user_name;
  const line = E.fwdFrom(name.trim() || E.fwdUnknown);
  return { plain: line + '\n', html: `<i>${escapeText(line)}</i>\n` };
}

function htmlToPlain(s) {
  return s.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

function textPart(chunk) {
  return { type: 'text', text: chunk.text, html: chunk.html, plain: chunk.html ? htmlToPlain(chunk.text) : chunk.text };
}

function mapLink(lat, lon) {
  return `https://www.google.com/maps?q=${lat},${lon}`;
}

// The parts a post is sent as (deterministic, so a retry resumes where it
// stopped): [{ type: 'text', text, html, plain } | { type: 'file', spec,
// caption, fallback }], plus issue codes. `extra` adds { suffix } (the
// album link in "first item" mode).
export function buildParts(m, caps, ctx) {
  const issues = new Set();
  const opts = { tags: caps.tags, escapesOk: caps.escapesOk, countMarkup: caps.limitCountsMarkup };
  const prefix = forwardPrefix(m);
  const link = ctx.link;
  const suffix = ctx.suffix || '';
  const parts = [];

  const addText = (text, entities, pre) => {
    const r = toEitaaChunks(text + suffix, entities, { ...opts, limit: caps.textLimit, prefix: pre });
    r.issues.forEach((i) => issues.add(i));
    if (r.chunks.length > 1) issues.add('split');
    parts.push(...r.chunks.map(textPart));
  };

  if (typeof m.text === 'string' && m.text.length) {
    addText(m.text, m.entities, prefix);
    return { parts, issues };
  }

  const spec = fileSpecOf(m, issues);
  if (spec) {
    const caption = String(m.caption || '');
    const cap = toEitaaCaption(caption + suffix, m.caption_entities, { ...opts, limit: caps.captionLimit, prefix });
    cap.issues.forEach((i) => issues.add(i));
    // What to send instead if the file is too big for the bot to download.
    const tooBig = E.bigFile(ctx.public ? link : '');
    const fallbackText = caption || ctx.public ? (caption ? caption + '\n\n' : '') + tooBig : '';
    const fallback = fallbackText
      ? toEitaaChunks(fallbackText + suffix, m.caption_entities, { ...opts, limit: caps.textLimit, prefix }).chunks.map(textPart)
      : [];
    if (spec.size > MAX_FILE_BYTES) {
      issues.add('too_large');
      parts.push(...fallback);
      return { parts, issues };
    }
    if (cap.fits) {
      parts.push({ type: 'file', spec, caption: cap.caption.text ? cap.caption : null, fallback });
    } else {
      // Too long for a caption: the file, then the text as its own post.
      issues.add('long_caption');
      parts.push({ type: 'file', spec, caption: null, fallback });
      const r = toEitaaChunks(caption + suffix, m.caption_entities, { ...opts, limit: caps.textLimit, prefix });
      parts.push(...r.chunks.map(textPart));
    }
    return { parts, issues };
  }

  if (m.sticker) {
    issues.add('sticker');
    return { parts, issues };
  }
  if (m.venue && m.venue.location) {
    const v = m.venue;
    addText(E.venueText(v.title, v.address, mapLink(v.location.latitude, v.location.longitude)), [], prefix);
    return { parts, issues };
  }
  if (m.location) {
    addText(E.locationText(mapLink(m.location.latitude, m.location.longitude)), [], prefix);
    return { parts, issues };
  }
  if (m.contact) {
    const c = m.contact;
    addText(E.contactText([c.first_name, c.last_name].filter(Boolean).join(' '), c.phone_number), [], prefix);
    return { parts, issues };
  }
  if (m.poll) {
    issues.add('poll');
    addText(E.pollText(m.poll.question, (m.poll.options || []).map((o) => o.text), link), [], prefix);
    return { parts, issues };
  }
  issues.add('unsupported');
  return { parts, issues };
}

// ── Sending ─────────────────────────────────────────────────────────────────

async function download(spec) {
  if (spec.size > MAX_FILE_BYTES) return { ok: false, reason: 'too_large' };
  try {
    return { ok: true, bytes: await api.getFileContent(spec.fileId) };
  } catch (e) {
    const tooBig = e instanceof BotApiError && /too big|too large/i.test(String(e.description));
    return { ok: false, reason: tooBig ? 'too_large' : 'download', temporary: !tooBig };
  }
}

async function callWithRetry(token, method, params, file) {
  let r = await eitaaCall(token, method, params, file);
  const reason = classifyEitaa(r);
  if (!r.ok && isTemporary(reason) && !r.network) {
    const wait = Number((r.parameters && r.parameters.retry_after) || r.retry_after) || 1;
    if (wait <= RETRY_WAIT_MAX_SECONDS) {
      await sleep(wait * 1000);
      r = await eitaaCall(token, method, params, file);
    }
  }
  return r;
}

// Sends one part. Returns the EitaaYar envelope or { ok: false, reason }.
async function sendPart(token, ch, part, title, replyTo, issues) {
  const base = { chat_id: ch.eitaaChatId, title };
  if (replyTo) base.reply_to_message_id = replyTo;

  const send = async (params, bytes) => {
    if (part.type === 'text') return callWithRetry(token, 'sendMessage', params);
    let r = await callWithRetry(token, 'sendFile', params, new InputFile(bytes, part.spec.name, { type: part.spec.mime }));
    const ascii = asciiName(part.spec.name);
    if (!r.ok && classifyEitaa(r) === 'rejected' && ascii !== part.spec.name) {
      r = await callWithRetry(token, 'sendFile', params, new InputFile(bytes, ascii, { type: part.spec.mime }));
    }
    return r;
  };
  // Refused: try without the reply, then without formatting.
  const withFallbacks = async (params, bytes) => {
    let r = await send(params, bytes);
    if (!r.ok && classifyEitaa(r) === 'rejected' && params.reply_to_message_id) {
      issues.add('reply');
      const { reply_to_message_id: _drop, ...rest } = params;
      params = rest;
      r = await send(params, bytes);
    }
    if (!r.ok && classifyEitaa(r) === 'rejected' && params.parse_mode) {
      issues.add('format');
      const { parse_mode: _p, ...rest } = params;
      if (part.type === 'text') rest.text = part.plain;
      else if (rest.caption) rest.caption = htmlToPlain(rest.caption);
      r = await send(rest, bytes);
    }
    return r;
  };

  if (part.type === 'text') {
    const params = { ...base, text: part.text };
    if (part.html) params.parse_mode = 'html';
    return withFallbacks(params);
  }
  const d = await download(part.spec);
  if (!d.ok) return d;
  const params = { ...base };
  if (part.caption) {
    params.caption = part.caption.text;
    if (part.caption.html) params.parse_mode = 'html';
  }
  return withFallbacks(params, d.bytes);
}

async function eitaaIdFor(tgChannelId, tgMessageId) {
  const row = await db.get(sql`
    SELECT eitaa_ids FROM eitaa_posts
    WHERE tg_channel_id = ${tgChannelId} AND tg_message_id = ${tgMessageId} AND status IN ('done', 'partial')`);
  const ids = row ? JSON.parse(row.eitaa_ids || '[]') : [];
  return ids.find((x) => x) || null;
}

// Sends what is left of a post. Returns { status: done | partial | skipped
// | retry | failed, issues, reason? }. Progress (ids, parts_done) is saved
// after every part.
async function sendPost(ch, token, m, row, caps, deadline) {
  const info = await channelInfo(ch.tgChannelId);
  const link = postLink(ch.tgChannelId, info.username, row.tg_message_id);
  const ctx = { link, public: Boolean(info.username) };
  if (row.kind === 'album') ctx.suffix = '\n\n' + E.albumLinkLine(link);
  const { parts, issues } = buildParts(m, caps, ctx);
  if (row.kind === 'album') issues.add('album_first');
  if (!parts.length) return { status: 'skipped', issues };

  const ids = JSON.parse(row.eitaa_ids || '[]');
  let replyTo = null;
  if (row.reply_to) {
    replyTo = await eitaaIdFor(ch.tgChannelId, row.reply_to);
    if (!replyTo) issues.add('reply');
  }

  for (let i = Number(row.parts_done) || 0; i < parts.length; i++) {
    if (Date.now() > deadline && i > (Number(row.parts_done) || 0)) return { status: 'retry', reason: 'timeout', issues };
    const title = i === 0 ? `tg-${row.tg_message_id}` : `tg-${row.tg_message_id}-${i + 1}`;
    let r = await sendPart(token, ch, parts[i], title, i === 0 ? replyTo : null, issues);
    if (!r.ok && r.reason === 'too_large') {
      // file_size was missing or wrong: send the fallback text instead.
      issues.add('too_large');
      const fb = parts[i].fallback || [];
      parts.splice(i, 1, ...fb);
      i--;
      continue;
    }
    if (!r.ok) {
      const reason = r.reason || classifyEitaa(r);
      if (r.reason === 'download') return { status: 'retry', reason: 'download', issues };
      return { status: isTemporary(reason) ? 'retry' : 'failed', reason, detail: describeFailure(r), issues };
    }
    ids.push(messageIdOf(r));
    await db.run(sql`
      UPDATE eitaa_posts SET eitaa_ids = ${JSON.stringify(ids)}, parts_done = ${i + 1}, updated_at = ${now()}
      WHERE tg_channel_id = ${ch.tgChannelId} AND tg_message_id = ${row.tg_message_id}`);
  }
  if (!ids.length) return { status: 'skipped', issues };
  const notable = [...issues].filter((x) => x !== 'split');
  return { status: notable.length ? 'partial' : 'done', issues };
}

// The post as it is now, read back from Telegram (see the top comment).
async function refetch(ch, tgMessageId) {
  let fwd;
  try {
    fwd = await api.forwardMessage({
      chat_id: ch.ownerTgId, from_chat_id: ch.tgChannelId, message_id: tgMessageId, disable_notification: true,
    });
  } catch (e) {
    const desc = String((e && e.description) || '').toLowerCase();
    if (e && e.code === 400 && /not found|message_id_invalid|message to forward/.test(desc)) return { gone: true };
    if (/protect|can't be forwarded|cannot be forwarded/.test(desc)) return { ok: false, reason: 'protected' };
    if (e && e.code === 403) return { ok: false, reason: 'owner_blocked' };
    return { ok: false, reason: 'telegram', temporary: true };
  }
  await api.deleteMessage({ chat_id: ch.ownerTgId, message_id: fwd.message_id }).catch(() => null);
  const m = { ...fwd, message_id: tgMessageId, chat: { id: ch.tgChannelId, type: 'channel' } };
  const o = fwd.forward_origin;
  const own = o && o.type === 'channel' && o.chat && o.chat.id === ch.tgChannelId && o.message_id === tgMessageId;
  if (own || !o) {
    delete m.forward_origin;
  }
  delete m.forward_from_chat;
  delete m.forward_from_message_id;
  delete m.forward_date;
  return { ok: true, message: m };
}

// ── Queue ───────────────────────────────────────────────────────────────────

async function acquire(tgChannelId, waitMs) {
  const until = Date.now() + waitMs;
  for (;;) {
    const t = now();
    const r = await db.run(sql`
      UPDATE eitaa_channels SET lock_until = ${t + LOCK_SECONDS}
      WHERE tg_channel_id = ${tgChannelId} AND lock_until < ${t}`);
    if (r.rowsAffected > 0) return true;
    if (Date.now() >= until) return false;
    // No timers on the platform: wait by reading until the lock is free.
    while (Date.now() < until) {
      if (await sleep(250)) break;
      const row = await db.get(sql`SELECT lock_until FROM eitaa_channels WHERE tg_channel_id = ${tgChannelId}`);
      if (!row || row.lock_until < now()) break;
    }
  }
}

async function release(tgChannelId) {
  await db.run(sql`UPDATE eitaa_channels SET lock_until = 0 WHERE tg_channel_id = ${tgChannelId}`);
}

async function finishRow(ch, row, status, issues, lastError) {
  await db.run(sql`
    UPDATE eitaa_posts SET status = ${status}, issues = ${[...(issues || [])].join(',') || null},
      last_error = ${lastError || null}, updated_at = ${now()}
    WHERE tg_channel_id = ${ch.tgChannelId} AND tg_message_id = ${row.tg_message_id}`);
  const column = status === 'done' ? 'sent_count' : status === 'failed' ? 'failed_count' : 'partial_count';
  await db.run(sql`UPDATE eitaa_channels SET ${sql.raw(column)} = ${sql.raw(column)} + 1 WHERE tg_channel_id = ${ch.tgChannelId}`);
}

async function notifyIssues(ch, row, status, issues, reason) {
  const info = await channelInfo(ch.tgChannelId);
  const link = postLink(ch.tgChannelId, info.username, row.tg_message_id);
  if (status === 'failed') return tell(ch.ownerTgId, E.postFailed(info.title, link, E.reasonText(reason)));
  const notable = [...(issues || [])].filter((i) => NOTIFY_ISSUES.has(i));
  if (notable.length) await tell(ch.ownerTgId, E.postIncomplete(info.title, link, notable.map(E.issueLabel).join('، ')));
  return null;
}

// Stops a mirror whose token or channel stopped working, and says why.
async function stopChannel(ch, reason, detail) {
  await db.run(sql`
    UPDATE eitaa_channels SET status = 'stopped', stop_reason = ${reason} WHERE tg_channel_id = ${ch.tgChannelId}`);
  const info = await channelInfo(ch.tgChannelId);
  await tell(ch.ownerTgId, E.channelStopped(info.title, reason, ch.mode), {
    reply_markup: { inline_keyboard: [[{ text: E.btnResume, callback_data: `e:res:${ch.tgChannelId}` }]] },
  });
  return { reason, detail };
}

// Sends the channel's queued posts in order. `live` is the post this run
// received (sent from memory instead of being re-read). Returns a status:
// empty | retry | timeout | busy | stopped | inactive.
export async function processQueue(tgChannelId, { live, deadline, waitMs } = {}) {
  deadline = deadline || Date.now() + 10000;
  if (!(await acquire(tgChannelId, waitMs === undefined ? (live ? LOCK_WAIT_MS : 0) : waitMs))) return 'busy';
  try {
    const ch = await getEitaaChannel(tgChannelId);
    if (!ch || ch.status !== 'active') return 'inactive';
    const token = await channelToken(ch);
    if (!token) {
      await stopChannel(ch, 'token');
      return 'stopped';
    }
    const caps = await eitaaCaps();
    let recovered = false;

    for (;;) {
      if (Date.now() > deadline) return 'timeout';
      const row = await db.get(sql`
        SELECT * FROM eitaa_posts WHERE tg_channel_id = ${tgChannelId} AND status = 'queued'
        ORDER BY tg_message_id LIMIT 1`);
      if (!row) break;

      let m = live && live.message_id === Number(row.tg_message_id) ? live : null;
      if (!m) {
        const f = await refetch(ch, Number(row.tg_message_id));
        if (f.gone) {
          await finishRow(ch, row, 'skipped', ['deleted']);
          continue;
        }
        if (!f.ok && f.temporary) return 'retry';
        if (!f.ok) {
          await finishRow(ch, row, 'failed', [f.reason], f.reason);
          await notifyIssues(ch, row, 'failed', null, f.reason);
          continue;
        }
        m = f.message;
      }

      let r;
      try {
        r = await sendPost(ch, token, m, row, caps, deadline);
      } catch (e) {
        console.error('eitaa send failed:', e && e.name);
        r = { status: 'retry', reason: 'unavailable', issues: new Set() };
      }

      if (r.status === 'retry') {
        if (r.reason === 'timeout') return 'timeout';
        const attempts = Number(row.attempts) + 1;
        await db.run(sql`
          UPDATE eitaa_posts SET attempts = ${attempts}, last_error = ${r.reason}, updated_at = ${now()}
          WHERE tg_channel_id = ${tgChannelId} AND tg_message_id = ${row.tg_message_id}`);
        if (attempts >= MAX_ATTEMPTS) {
          await finishRow(ch, row, 'failed', r.issues, r.reason);
          await notifyIssues(ch, row, 'failed', null, r.reason);
          continue;
        }
        if (attempts >= ALERT_AFTER_ATTEMPTS && !ch.alerted) {
          await db.run(sql`UPDATE eitaa_channels SET alerted = 1 WHERE tg_channel_id = ${tgChannelId}`);
          const info = await channelInfo(tgChannelId);
          await tell(ch.ownerTgId, E.stuck(info.title), {
            reply_markup: { inline_keyboard: [[{ text: E.btnRetry, callback_data: `e:rt:${tgChannelId}` }]] },
          });
        }
        return 'retry';
      }

      if (r.status === 'failed' && (r.reason === 'auth' || r.reason === 'chat')) {
        // Every later post would fail the same way: keep this one queued.
        console.warn('eitaa mirror stopped:', r.reason, r.detail);
        await stopChannel(ch, r.reason, r.detail);
        return 'stopped';
      }

      await finishRow(ch, row, r.status, r.issues, r.reason);
      if (r.status === 'failed') console.warn('eitaa post refused:', r.detail);
      await notifyIssues(ch, row, r.status, r.issues, r.reason);
      if (ch.alerted) recovered = true;
    }

    if (recovered) {
      await db.run(sql`UPDATE eitaa_channels SET alerted = 0 WHERE tg_channel_id = ${tgChannelId}`);
      await tell(ch.ownerTgId, E.recovered((await channelInfo(tgChannelId)).title));
    }
    return 'empty';
  } finally {
    await release(tgChannelId);
  }
}

// ── Entry points from the handlers ──────────────────────────────────────────

// Album items arrive one by one. The first item seen claims the album; in
// "skip" mode nothing is sent and the owner gets one notice, in "first"
// mode that item goes out alone with a link to the album. Returns true when
// `post` is to be sent.
async function claimAlbum(ch, post) {
  const t = now();
  const claimed = await db.run(sql`
    INSERT OR IGNORE INTO eitaa_albums (tg_channel_id, media_group_id, first_tg_id, created_at)
    VALUES (${ch.tgChannelId}, ${String(post.media_group_id)}, ${post.message_id}, ${t})`);
  if (!claimed.rowsAffected) return false;

  if (ch.albumPolicy === 'first') {
    await db.run(sql`
      INSERT OR IGNORE INTO eitaa_posts (tg_channel_id, tg_message_id, kind, status, created_at, updated_at)
      VALUES (${ch.tgChannelId}, ${post.message_id}, 'album', 'queued', ${t}, ${t})`);
    return true;
  }
  const r = await db.run(sql`
    INSERT OR IGNORE INTO eitaa_posts (tg_channel_id, tg_message_id, kind, status, issues, created_at, updated_at)
    VALUES (${ch.tgChannelId}, ${post.message_id}, 'album', 'skipped', 'album', ${t}, ${t})`);
  if (r.rowsAffected) {
    await db.run(sql`UPDATE eitaa_channels SET partial_count = partial_count + 1 WHERE tg_channel_id = ${ch.tgChannelId}`);
    const info = await channelInfo(ch.tgChannelId);
    await tell(ch.ownerTgId, E.albumSkipped(info.title, postLink(ch.tgChannelId, info.username, post.message_id)));
  }
  return false;
}

// handlers/channel_post: a new post in a Telegram channel.
export async function mirrorChannelPost(post, { deadline }) {
  const ch = await getEitaaChannel(post.chat.id);
  if (!ch || ch.status !== 'active' || (await ownerBlocked(ch))) return;
  if (post.chat.username) titles.set(ch.tgChannelId, { title: post.chat.title || String(ch.tgChannelId), username: post.chat.username });

  let live = null;
  if (hasContent(post)) {
    if (post.media_group_id) {
      if (await claimAlbum(ch, post)) live = post;
    } else {
      const t = now();
      const replyTo = post.reply_to_message && post.reply_to_message.chat && post.reply_to_message.chat.id === post.chat.id
        ? post.reply_to_message.message_id : null;
      const r = await db.run(sql`
        INSERT OR IGNORE INTO eitaa_posts (tg_channel_id, tg_message_id, kind, status, reply_to, had_markup, created_at, updated_at)
        VALUES (${ch.tgChannelId}, ${post.message_id}, 'post', 'queued', ${replyTo}, ${post.reply_markup ? 1 : 0}, ${t}, ${t})`);
      if (r.rowsAffected) live = post; // else a redelivery
    }
  }
  const status = await processQueue(ch.tgChannelId, { live, deadline });
  if (status === 'empty' && Date.now() < deadline) await sweepDeletions(ch.tgChannelId, { deadline: deadline + 3000 });
}

// handlers/edited_channel_post. Applied in Eitaa only with a method the bot
// owner confirmed; otherwise the channel owner is told what to edit.
export async function mirrorEdit(post) {
  const ch = await getEitaaChannel(post.chat.id);
  if (!ch || ch.status !== 'active' || (await ownerBlocked(ch))) return;
  const row = await db.get(sql`
    SELECT * FROM eitaa_posts WHERE tg_channel_id = ${ch.tgChannelId} AND tg_message_id = ${post.message_id}`);
  if (!row) return;
  const editDate = Number(post.edit_date) || now();
  const fresh = await db.run(sql`
    UPDATE eitaa_posts SET edit_date = ${editDate}, had_markup = ${post.reply_markup ? 1 : 0}
    WHERE tg_channel_id = ${ch.tgChannelId} AND tg_message_id = ${post.message_id} AND edit_date < ${editDate}`);
  if (!fresh.rowsAffected) return; // redelivered edit
  // Still queued: the edited version is what gets sent (it is re-read).
  if (row.status !== 'done' && row.status !== 'partial') return;

  const ids = JSON.parse(row.eitaa_ids || '[]').filter(Boolean);
  if (await tryAutoEdit(ch, post, row, ids)) return;
  if (!ch.notifyEdits) return;

  const info = await channelInfo(ch.tgChannelId);
  await tell(ch.ownerTgId, E.editNotice(info.title, postLink(ch.tgChannelId, info.username, post.message_id), row.tg_message_id));
  // The new version, ready to copy (sent, not stored).
  try {
    await api.copyMessage({ chat_id: ch.ownerTgId, from_chat_id: ch.tgChannelId, message_id: post.message_id });
  } catch {
    const text = post.text || post.caption;
    if (text) await api.sendMessage({ chat_id: ch.ownerTgId, text: String(text).slice(0, 4096) }).catch(() => null);
  }
}

async function tryAutoEdit(ch, post, row, ids) {
  const caps = await eitaaCaps();
  const isText = typeof post.text === 'string';
  const method = isText ? caps.editMethod : caps.editCaptionMethod;
  if (!method || ids.length !== 1 || row.kind !== 'post') return false;
  const token = await channelToken(ch);
  if (!token) return false;
  const info = await channelInfo(ch.tgChannelId);
  const { parts } = buildParts(post, caps, { link: postLink(ch.tgChannelId, info.username, post.message_id), public: Boolean(info.username) });
  if (parts.length !== 1) return false;
  const p = parts[0];
  const params = { chat_id: ch.eitaaChatId, message_id: ids[0] };
  if (isText) {
    if (p.type !== 'text') return false;
    params.text = p.text;
    if (p.html) params.parse_mode = 'html';
  } else {
    if (p.type !== 'file') return false;
    params.caption = p.caption ? p.caption.text : '';
    if (p.caption && p.caption.html) params.parse_mode = 'html';
  }
  const r = await eitaaCall(token, method, params);
  if (r.ok) await db.run(sql`
    UPDATE eitaa_posts SET issues = trim(coalesce(issues, '') || ',edited', ',')
    WHERE tg_channel_id = ${ch.tgChannelId} AND tg_message_id = ${row.tg_message_id}`);
  return r.ok;
}

// ── Deletions ───────────────────────────────────────────────────────────────

async function postGone(chatId, messageId) {
  try {
    await api.editMessageReplyMarkup({ chat_id: chatId, message_id: messageId });
    return false;
  } catch (e) {
    return Boolean(e && e.code === 400 && /message to edit not found/i.test(String(e.description)));
  }
}

async function onDeleted(ch, row) {
  const caps = await eitaaCaps();
  const ids = JSON.parse(row.eitaa_ids || '[]').filter(Boolean);
  let removed = false;
  if (caps.deleteMethod && ids.length) {
    const token = await channelToken(ch);
    if (token) {
      removed = true;
      for (const id of ids) {
        const r = await eitaaCall(token, caps.deleteMethod, { chat_id: ch.eitaaChatId, message_id: id });
        if (!r.ok) removed = false;
      }
    }
  }
  await db.run(sql`
    UPDATE eitaa_posts SET status = 'deleted', updated_at = ${now()}
    WHERE tg_channel_id = ${ch.tgChannelId} AND tg_message_id = ${row.tg_message_id}`);
  if (ch.notifyEdits) {
    const info = await channelInfo(ch.tgChannelId);
    await tell(ch.ownerTgId, removed ? E.deletedBoth(info.title, row.tg_message_id) : E.deleteNotice(info.title, row.tg_message_id, ids.length));
  }
}

// Checks the channel's last mirrored posts for deletions (at most once a
// minute unless `force`). Returns the number of deleted posts found, or -1
// when the check was skipped.
export async function sweepDeletions(tgChannelId, { deadline, force } = {}) {
  deadline = deadline || Date.now() + 8000;
  const t = now();
  const claimed = await db.run(sql`
    UPDATE eitaa_channels SET probed_at = ${t}
    WHERE tg_channel_id = ${tgChannelId} AND (${force ? 1 : 0} = 1 OR probed_at < ${t - PROBE_INTERVAL_SECONDS})`);
  if (!claimed.rowsAffected) return -1;
  const ch = await getEitaaChannel(tgChannelId);
  if (!ch) return -1;

  // With "edit messages" rights the probe could remove a post's buttons:
  // posts that have buttons are then left alone.
  let canEdit = false;
  try {
    const me = await api.getMe();
    const bot = await api.getChatMember({ chat_id: tgChannelId, user_id: me.id });
    canEdit = bot.can_edit_messages === true;
  } catch {
    return -1;
  }

  const rows = rowsOf(await db.all(sql`
    SELECT * FROM eitaa_posts
    WHERE tg_channel_id = ${tgChannelId} AND status IN ('done', 'partial') AND created_at > ${t - PROBE_WINDOW_SECONDS}
    ORDER BY tg_message_id DESC LIMIT ${PROBE_LAST_N}`));
  let gone = 0;
  for (const row of rows) {
    if (Date.now() > deadline) break;
    if (row.had_markup && canEdit) continue;
    const mid = Number(row.tg_message_id);
    // Asked twice, so a one-off glitch can't count as a deletion.
    if ((await postGone(tgChannelId, mid)) && (await postGone(tgChannelId, mid))) {
      await onDeleted(ch, row);
      gone++;
    }
    await db.run(sql`UPDATE eitaa_posts SET checked_at = ${now()} WHERE tg_channel_id = ${tgChannelId} AND tg_message_id = ${mid}`);
  }
  return gone;
}

// ── Buttons, scheduled run, report ──────────────────────────────────────────

// «تلاش دوباره»: failed posts of the last 2 days go back in the queue.
export async function retryChannel(tgChannelId) {
  await db.run(sql`
    UPDATE eitaa_posts SET status = 'queued', attempts = 0
    WHERE tg_channel_id = ${tgChannelId} AND status = 'failed' AND created_at > ${now() - 2 * 86400}
      AND coalesce(last_error, '') NOT IN ('protected', 'too_large')`);
  await db.run(sql`UPDATE eitaa_posts SET attempts = 0 WHERE tg_channel_id = ${tgChannelId} AND status = 'queued'`);
  return processQueue(tgChannelId, { deadline: Date.now() + 12000, waitMs: 3000 });
}

export async function queuedCount(tgChannelId) {
  const r = await db.get(sql`
    SELECT count(*) AS n FROM eitaa_posts WHERE tg_channel_id = ${tgChannelId} AND status IN ('queued', 'failed')`);
  return Number(r && r.n) || 0;
}

// Scheduled run (__drain): every active mirror's queue and deletions.
// Returns counts by status only (CI logs are public).
export async function drainEitaa(budgetMs) {
  const end = Date.now() + (budgetMs || 8000);
  const out = {};
  const list = rowsOf(await db.all(sql`SELECT tg_channel_id FROM eitaa_channels WHERE status = 'active'`));
  for (const row of list) {
    if (Date.now() > end) {
      out.later = (out.later || 0) + 1;
      continue;
    }
    const id = Number(row.tg_channel_id);
    const status = await processQueue(id, { deadline: Math.min(end, Date.now() + 6000) });
    if (status === 'empty') await sweepDeletions(id, { deadline: Math.min(end, Date.now() + 3000) });
    out[status] = (out[status] || 0) + 1;
  }
  const t = now();
  await db.run(sql`DELETE FROM eitaa_posts WHERE created_at < ${t - RETENTION_SECONDS}`);
  await db.run(sql`DELETE FROM eitaa_albums WHERE created_at < ${t - RETENTION_SECONDS}`);
  return out;
}

export async function recentPosts(tgChannelId, limit) {
  return rowsOf(await db.all(sql`
    SELECT tg_message_id, kind, status, issues, last_error, eitaa_ids FROM eitaa_posts
    WHERE tg_channel_id = ${tgChannelId} ORDER BY tg_message_id DESC LIMIT ${limit}`));
}
