// Delivers Telegram messages (single ones and albums) to a Bale chat.
// Forwarded messages go out like the sender's own: no "forwarded from" line.

import { api, InputFile, BotApiError } from 'sdk';
import { baleCall, classifyError } from './bale.js';
import { formatChunks, toBaleMarkdown } from './format.js';
import { MAX_FILE_BYTES } from './util.js';

// Bale accepts 1–4096 characters for text; keep a margin for the markers.
const BALE_TEXT_LIMIT = 4000;
// Longer captions are sent as a following text message.
const BALE_CAPTION_LIMIT = 1024;
// Bale's sendMediaGroup InputMedia types.
const ALBUM_TYPES = new Set(['photo', 'video', 'document', 'audio']);

// What to send for a media message: Bale method, upload field and the
// Telegram file. Plain data, so album items can be stored as JSON.
export function mediaSpec(m) {
  const spec = (kind, method, f, name, mime, extra) => ({
    kind, method, field: kind, fileId: f.file_id, size: f.file_size || 0, name, mime, ...extra,
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

function captionOf(m) {
  return m.caption ? toBaleMarkdown(m.caption, m.caption_entities) : '';
}

async function sendText(chatId, text, entities) {
  for (const part of formatChunks(text, entities, BALE_TEXT_LIMIT)) {
    const r = await baleCall('sendMessage', { chat_id: chatId, text: part });
    if (!r.ok) return r;
  }
  return { ok: true };
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

// Sends one media file. `bytes` may be passed when already downloaded.
async function sendMedia(chatId, spec, caption, bytes) {
  if (!bytes) {
    const d = await download(spec);
    if (!d.ok) return d;
    bytes = d.bytes;
  }

  let separateText = '';
  if (spec.noCaption || caption.length > BALE_CAPTION_LIMIT) {
    separateText = caption;
    caption = '';
  }

  const params = { chat_id: chatId };
  if (caption) params.caption = caption;
  let r = await baleCall(spec.method, params, { [spec.field]: new InputFile(bytes, spec.name, { type: spec.mime }) });

  // Bale is pickier than Telegram about some media; fall back to a plain file.
  if (!r.ok && r.error_code === 400 && spec.method !== 'sendDocument' && spec.method !== 'sendPhoto') {
    r = await baleCall('sendDocument', params, { document: new InputFile(bytes, spec.name, { type: spec.mime }) });
  }
  if (!r.ok) return r;
  if (separateText) return sendTextFormatted(chatId, separateText);
  return r;
}

// Already-formatted text (a caption that didn't fit), split plainly.
async function sendTextFormatted(chatId, text) {
  return sendText(chatId, text, []);
}

// Returns { ok: true } or { ok: false, reason } where reason is a key of T.fail.
export async function deliver(baleChatId, m) {
  let r;
  const spec = mediaSpec(m);
  if (typeof m.text === 'string' && m.text.length) {
    r = await sendText(baleChatId, m.text, m.entities);
  } else if (spec) {
    r = await sendMedia(baleChatId, spec, captionOf(m));
  } else if (m.location) {
    r = await baleCall('sendLocation', {
      chat_id: baleChatId,
      latitude: m.location.latitude,
      longitude: m.location.longitude,
    });
    if (r.ok && m.venue && m.venue.title) {
      r = await sendText(baleChatId, [m.venue.title, m.venue.address].filter(Boolean).join('\n'));
    }
  } else if (m.contact) {
    const params = {
      chat_id: baleChatId,
      phone_number: m.contact.phone_number,
      first_name: m.contact.first_name || '-',
    };
    if (m.contact.last_name) params.last_name = m.contact.last_name;
    r = await baleCall('sendContact', params);
  } else {
    return { ok: false, reason: 'unsupported' };
  }
  return r.ok ? { ok: true } : failure(r);
}

// ── Albums ──────────────────────────────────────────────────────────────────

// The part of an album message needed to send it later (stored as JSON for
// a few seconds; see schema.js), or null when it can't go in an album.
export function albumItemOf(m) {
  const spec = mediaSpec(m);
  if (!spec || !ALBUM_TYPES.has(spec.kind)) return null;
  return { messageId: m.message_id, spec, caption: captionOf(m) };
}

// Sends album items (sorted by message id) as one Bale album. Falls back to
// one message per item when Bale refuses the album.
export async function deliverAlbum(baleChatId, items) {
  items = items.slice().sort((a, b) => a.messageId - b.messageId);
  const files = [];
  for (const it of items) {
    const d = await download(it.spec);
    if (!d.ok) return d;
    files.push(d.bytes);
  }

  if (items.length >= 2) {
    const media = [];
    const uploads = {};
    let extraText = '';
    items.forEach((it, i) => {
      const entry = { type: it.spec.kind, media: `attach://file${i}` };
      if (it.caption && it.caption.length <= BALE_CAPTION_LIMIT) entry.caption = it.caption;
      else if (it.caption) extraText += (extraText ? '\n\n' : '') + it.caption;
      media.push(entry);
      uploads[`file${i}`] = new InputFile(files[i], it.spec.name, { type: it.spec.mime });
    });
    const r = await baleCall('sendMediaGroup', { chat_id: baleChatId, media }, uploads);
    if (r.ok) {
      if (extraText) {
        const t = await sendTextFormatted(baleChatId, extraText);
        if (!t.ok) return failure(t);
      }
      return { ok: true };
    }
    // Only a refusal of the album itself is worth retrying item by item.
    const reason = classifyError(r);
    if (reason !== 'rejected') return failure(r);
    console.warn('bale refused album, sending items one by one:', r.error_code);
  }

  for (let i = 0; i < items.length; i++) {
    const r = await sendMedia(baleChatId, items[i].spec, items[i].caption, files[i]);
    if (!r.ok) return failure(r);
  }
  return { ok: true };
}

function failure(r) {
  if (r.reason) return { ok: false, reason: r.reason };
  return { ok: false, reason: classifyError(r) || 'rejected' };
}
