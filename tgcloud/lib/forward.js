// Turns Telegram messages (single ones and albums) into a plan of Bale
// sends, and runs it. A plan is plain data and records its progress, so a
// queued channel post that fails halfway resumes where it stopped instead
// of sending its first parts twice.
// Forwarded messages go out like the sender's own: no "forwarded from" line.

import { api, InputFile, BotApiError } from 'sdk';
import { baleCall, classifyError } from './bale.js';
import { formatChunks, toBaleMarkdown } from './format.js';
import { MAX_FILE_BYTES } from './util.js';

// Bale accepts 1–4096 characters for text; keep a margin for the markers.
export const BALE_TEXT_LIMIT = 4000;
// Longer captions are sent as a following text message.
export const BALE_CAPTION_LIMIT = 1024;
// Bale's sendMediaGroup InputMedia types.
const ALBUM_TYPES = new Set(['photo', 'video', 'document', 'audio']);

// What to send for a media message: Bale method, upload field and the
// Telegram file.
export function mediaSpec(m) {
  const spec = (kind, method, f, name, mime, extra) => ({
    kind, method, field: kind, fileId: f.file_id, fileUid: f.file_unique_id || null,
    size: f.file_size || 0, name, mime, ...extra,
  });
  if (m.photo && m.photo.length) {
    return spec('photo', 'sendPhoto', m.photo[m.photo.length - 1], 'photo.jpg', 'image/jpeg');
  }
  if (m.animation) {
    const a = m.animation;
    // sendAnimation has no caption parameter in Bale's docs.
    return spec('animation', 'sendAnimation', a, a.file_name || 'animation.mp4', a.mime_type || 'video/mp4', { noCaption: true });
  }
  if (m.video) {
    const v = m.video;
    return spec('video', 'sendVideo', v, v.file_name || 'video.mp4', v.mime_type || 'video/mp4');
  }
  if (m.video_note) {
    return spec('video', 'sendVideo', m.video_note, 'video_note.mp4', 'video/mp4');
  }
  if (m.voice) {
    return spec('voice', 'sendVoice', m.voice, 'voice.ogg', m.voice.mime_type || 'audio/ogg');
  }
  if (m.audio) {
    const a = m.audio;
    return spec('audio', 'sendAudio', a, a.file_name || 'audio.mp3', a.mime_type || 'audio/mpeg');
  }
  if (m.document) {
    const d = m.document;
    return spec('document', 'sendDocument', d, d.file_name || 'file', d.mime_type || 'application/octet-stream');
  }
  return null;
}

export function isSupported(m) {
  return Boolean(
    (typeof m.text === 'string' && m.text.length) || mediaSpec(m) || m.location || m.contact
  );
}

export function captionOf(m) {
  return m.caption ? toBaleMarkdown(m.caption, m.caption_entities) : '';
}

// ── Plans ───────────────────────────────────────────────────────────────────
//
// plan = { ops: [...], next: 0, ids: { <tg message id>: [bale ids] },
//          layout: { <tg id>: 'text'|'media'|'media+text'|'other' },
//          fileUid: { <tg id>: file_unique_id } }
// ops: text { text, plain } · media { spec, caption } · group { items } ·
//      location { latitude, longitude } · contact { params }; each has tg.

function textOps(tg, text, entities) {
  return formatChunks(text, entities, BALE_TEXT_LIMIT).map((c) => ({ op: 'text', tg, text: c.text, plain: c.plain }));
}

// Already formatted text (a caption that didn't fit), split plainly.
function formattedTextOps(tg, text) {
  return formatChunks(text, [], BALE_TEXT_LIMIT).map((c) => ({ op: 'text', tg, text: c.text }));
}

function newPlan() {
  return { ops: [], next: 0, ids: {}, layout: {}, fileUid: {} };
}

// Plan for one message, or null when it can't be sent to Bale.
export function planMessage(m) {
  const plan = newPlan();
  const tg = m.message_id;
  const spec = mediaSpec(m);
  if (typeof m.text === 'string' && m.text.length) {
    plan.ops.push(...textOps(tg, m.text, m.entities));
    plan.layout[tg] = 'text';
  } else if (spec) {
    const caption = captionOf(m);
    if (spec.noCaption || caption.length > BALE_CAPTION_LIMIT) {
      plan.ops.push({ op: 'media', tg, spec, caption: '' });
      if (caption) plan.ops.push(...formattedTextOps(tg, caption));
      plan.layout[tg] = caption ? 'media+text' : 'media';
    } else {
      plan.ops.push({ op: 'media', tg, spec, caption });
      plan.layout[tg] = 'media';
    }
    plan.fileUid[tg] = spec.fileUid;
  } else if (m.location) {
    plan.ops.push({ op: 'location', tg, latitude: m.location.latitude, longitude: m.location.longitude });
    if (m.venue && m.venue.title) {
      plan.ops.push(...formattedTextOps(tg, [m.venue.title, m.venue.address].filter(Boolean).join('\n')));
    }
    plan.layout[tg] = 'other';
  } else if (m.contact) {
    const params = { phone_number: m.contact.phone_number, first_name: m.contact.first_name || '-' };
    if (m.contact.last_name) params.last_name = m.contact.last_name;
    plan.ops.push({ op: 'contact', tg, params });
    plan.layout[tg] = 'other';
  } else {
    return null;
  }
  return plan;
}

// The part of an album message needed to send it later, or null when it
// can't go in an album.
export function albumItemOf(m) {
  const spec = mediaSpec(m);
  if (!spec || !ALBUM_TYPES.has(spec.kind)) return null;
  return { tg: m.message_id, spec, caption: captionOf(m) };
}

// Plan for album items: one sendMediaGroup, then any captions too long for it.
export function planAlbum(items) {
  const plan = newPlan();
  items = items.slice().sort((a, b) => a.tg - b.tg);
  const groupItems = items.map((it) => ({
    tg: it.tg, spec: it.spec, caption: it.caption.length <= BALE_CAPTION_LIMIT ? it.caption : '',
  }));
  plan.ops.push(items.length > 1
    ? { op: 'group', tg: items[0].tg, items: groupItems }
    : { op: 'media', tg: items[0].tg, spec: items[0].spec, caption: groupItems[0].caption });
  for (const it of items) {
    plan.layout[it.tg] = 'media';
    plan.fileUid[it.tg] = it.spec.fileUid;
    if (it.caption.length > BALE_CAPTION_LIMIT) {
      plan.ops.push(...formattedTextOps(it.tg, it.caption));
      plan.layout[it.tg] = 'media+text';
    }
  }
  return plan;
}

// ── Running a plan ──────────────────────────────────────────────────────────

function messageId(r) {
  return r && r.result && r.result.message_id;
}

async function download(spec) {
  if (spec.size > MAX_FILE_BYTES) return { ok: false, reason: 'too_large' };
  try {
    return { ok: true, bytes: await api.getFileContent(spec.fileId) };
  } catch (e) {
    const tooBig = e instanceof BotApiError && /too big|too large/i.test(String(e.description));
    return { ok: false, reason: tooBig ? 'too_large' : 'download' };
  }
}

function upload(spec, bytes) {
  return new InputFile(bytes, spec.name, { type: spec.mime });
}

// Runs one op. Returns { ok: true, sent: [[tg, baleId], …] }, a failed Bale
// envelope / { ok: false, reason }, or { expand: [ops] } to replace the op.
async function runOp(chatId, op) {
  if (op.op === 'text') {
    let r = await baleCall('sendMessage', { chat_id: chatId, text: op.text });
    // If Bale refuses the Markdown, send the text unformatted.
    if (!r.ok && r.error_code === 400 && op.plain && op.plain !== op.text) {
      r = await baleCall('sendMessage', { chat_id: chatId, text: op.plain });
    }
    return r.ok ? { ok: true, sent: [[op.tg, messageId(r)]] } : r;
  }

  if (op.op === 'media') {
    const d = await download(op.spec);
    if (!d.ok) return d;
    const params = { chat_id: chatId };
    if (op.caption) params.caption = op.caption;
    let r = await baleCall(op.spec.method, params, { [op.spec.field]: upload(op.spec, d.bytes) });
    // Bale is pickier than Telegram about some media; fall back to a plain file.
    if (!r.ok && r.error_code === 400 && op.spec.method !== 'sendDocument' && op.spec.method !== 'sendPhoto') {
      r = await baleCall('sendDocument', params, { document: upload(op.spec, d.bytes) });
    }
    return r.ok ? { ok: true, sent: [[op.tg, messageId(r)]] } : r;
  }

  if (op.op === 'group') {
    const media = [];
    const uploads = {};
    for (let i = 0; i < op.items.length; i++) {
      const it = op.items[i];
      const d = await download(it.spec);
      if (!d.ok) return d;
      const entry = { type: it.spec.kind, media: `attach://file${i}` };
      if (it.caption) entry.caption = it.caption;
      media.push(entry);
      uploads[`file${i}`] = upload(it.spec, d.bytes);
    }
    const r = await baleCall('sendMediaGroup', { chat_id: chatId, media }, uploads);
    if (r.ok) {
      const sent = Array.isArray(r.result) ? r.result : [];
      return { ok: true, sent: op.items.map((it, i) => [it.tg, sent[i] && sent[i].message_id]) };
    }
    // Only a refusal of the album itself is worth retrying item by item.
    if (classifyError(r) === 'rejected') {
      console.warn('bale refused album, sending items one by one:', r.error_code);
      return { expand: op.items.map((it) => ({ op: 'media', tg: it.tg, spec: it.spec, caption: it.caption })) };
    }
    return r;
  }

  if (op.op === 'location') {
    const r = await baleCall('sendLocation', { chat_id: chatId, latitude: op.latitude, longitude: op.longitude });
    return r.ok ? { ok: true, sent: [[op.tg, messageId(r)]] } : r;
  }

  if (op.op === 'contact') {
    const r = await baleCall('sendContact', { chat_id: chatId, ...op.params });
    return r.ok ? { ok: true, sent: [[op.tg, messageId(r)]] } : r;
  }
  return { ok: false, reason: 'unsupported' };
}

// Runs the plan from plan.next, updating it in place. `onProgress(plan)` is
// awaited after each op (to persist it). Stops at `deadline` (ms), if given.
// Returns { ok: true } (all done), { ok: false, reason }, or
// { ok: false, reason: 'timeout' } when the deadline hit first.
export async function runPlan(chatId, plan, { onProgress, deadline } = {}) {
  while (plan.next < plan.ops.length) {
    if (deadline && Date.now() > deadline) return { ok: false, reason: 'timeout' };
    const op = plan.ops[plan.next];
    const r = await runOp(chatId, op);
    if (r.expand) {
      plan.ops.splice(plan.next, 1, ...r.expand);
      continue;
    }
    if (!r.ok) return failure(r);
    for (const [tg, baleId] of r.sent) {
      if (!plan.ids[tg]) plan.ids[tg] = [];
      if (baleId) plan.ids[tg].push(baleId);
    }
    plan.next++;
    if (onProgress) await onProgress(plan);
  }
  return { ok: true };
}

// Sends one message right away (private chats). Returns { ok } or { ok:
// false, reason } where reason is a key of T.fail.
export async function deliver(baleChatId, m) {
  const plan = planMessage(m);
  if (!plan) return { ok: false, reason: 'unsupported' };
  return runPlan(baleChatId, plan);
}

export async function deliverAlbum(baleChatId, items) {
  return runPlan(baleChatId, planAlbum(items));
}

export function failure(r) {
  if (r.reason) return { ok: false, reason: r.reason };
  return { ok: false, reason: classifyError(r) || 'rejected' };
}

// ── Edits ───────────────────────────────────────────────────────────────────

const notModified = (r) => !r.ok && r.error_code === 400 && /not modified/i.test(String(r.description));

// Edits Bale message `baleId` to `chunk` ({ text, plain? }).
export async function editTextChunk(chatId, baleId, chunk) {
  let r = await baleCall('editMessageText', { chat_id: chatId, message_id: baleId, text: chunk.text });
  if (notModified(r)) return { ok: true };
  if (!r.ok && r.error_code === 400 && chunk.plain && chunk.plain !== chunk.text) {
    r = await baleCall('editMessageText', { chat_id: chatId, message_id: baleId, text: chunk.plain });
    if (notModified(r)) return { ok: true };
  }
  return r;
}

export async function editCaption(chatId, baleId, caption) {
  const r = await baleCall('editMessageCaption', { chat_id: chatId, message_id: baleId, caption });
  return notModified(r) ? { ok: true } : r;
}

export async function sendTextChunk(chatId, chunk) {
  return runOp(chatId, { op: 'text', tg: 0, text: chunk.text, plain: chunk.plain });
}

export { formatChunks };
