// Delivers one Telegram message to the user's Bale chat.

import { api, InputFile, BotApiError } from 'sdk';
import { baleCall, classifyError } from './bale.js';
import { T } from './texts.js';
import { MAX_FILE_BYTES, fullName, splitText } from './util.js';

// Bale accepts 1–4096 characters for text and captions; keep a margin.
const BALE_TEXT_LIMIT = 4000;

// Name of the original source for forwarded messages, or ''.
function forwardSource(m) {
  const o = m.forward_origin;
  if (o) {
    if (o.type === 'user') return fullName(o.sender_user) || 'کاربر';
    if (o.type === 'hidden_user') return o.sender_user_name || 'کاربر';
    if (o.type === 'chat') return chatName(o.sender_chat, o.author_signature);
    if (o.type === 'channel') return chatName(o.chat, o.author_signature);
    return 'نامشخص';
  }
  // Pre-7.0 Bot API fields.
  if (m.forward_from_chat) return chatName(m.forward_from_chat, m.forward_signature);
  if (m.forward_from) return fullName(m.forward_from) || 'کاربر';
  if (m.forward_sender_name) return m.forward_sender_name;
  return '';
}

function chatName(chat, signature) {
  if (!chat) return 'نامشخص';
  let name = chat.title || fullName(chat) || 'نامشخص';
  if (chat.username) name += ` (@${chat.username})`;
  if (signature) name += ` — ${signature}`;
  return name;
}

// Picks the Bale method and Telegram file for a media message.
function mediaSpec(m) {
  if (m.photo && m.photo.length) {
    const p = m.photo[m.photo.length - 1];
    return { method: 'sendPhoto', field: 'photo', file: p, name: 'photo.jpg', mime: 'image/jpeg' };
  }
  if (m.animation) {
    const a = m.animation;
    return { method: 'sendAnimation', field: 'animation', file: a, name: a.file_name || 'animation.mp4', mime: a.mime_type || 'video/mp4', noCaption: true };
  }
  if (m.video) {
    const v = m.video;
    return { method: 'sendVideo', field: 'video', file: v, name: v.file_name || 'video.mp4', mime: v.mime_type || 'video/mp4' };
  }
  if (m.video_note) {
    return { method: 'sendVideo', field: 'video', file: m.video_note, name: 'video_note.mp4', mime: 'video/mp4' };
  }
  if (m.voice) {
    const v = m.voice;
    return { method: 'sendVoice', field: 'voice', file: v, name: 'voice.ogg', mime: v.mime_type || 'audio/ogg' };
  }
  if (m.audio) {
    const a = m.audio;
    return { method: 'sendAudio', field: 'audio', file: a, name: a.file_name || 'audio.mp3', mime: a.mime_type || 'audio/mpeg' };
  }
  if (m.document) {
    const d = m.document;
    return { method: 'sendDocument', field: 'document', file: d, name: d.file_name || 'file', mime: d.mime_type || 'application/octet-stream' };
  }
  return null;
}

export function isSupported(m) {
  return Boolean(
    (typeof m.text === 'string' && m.text.length) || mediaSpec(m) || m.location || m.contact
  );
}

async function sendText(chatId, text) {
  for (const part of splitText(text, BALE_TEXT_LIMIT)) {
    const r = await baleCall('sendMessage', { chat_id: chatId, text: part });
    if (!r.ok) return r;
  }
  return { ok: true };
}

async function sendMedia(chatId, m, header) {
  const spec = mediaSpec(m);
  if (spec.file.file_size && spec.file.file_size > MAX_FILE_BYTES) return { ok: false, reason: 'too_large' };

  let bytes;
  try {
    bytes = await api.getFileContent(spec.file.file_id);
  } catch (e) {
    const tooBig = e instanceof BotApiError && /too big|too large/i.test(String(e.description));
    return { ok: false, reason: tooBig ? 'too_large' : 'download' };
  }

  let caption = [header, m.caption].filter(Boolean).join('\n\n');
  let separateText = '';
  if (spec.noCaption || caption.length > BALE_TEXT_LIMIT) {
    // sendAnimation has no caption parameter in Bale's docs; long captions
    // go out as a following text message instead.
    separateText = caption;
    caption = '';
  }

  const file = new InputFile(bytes, spec.name, { type: spec.mime });
  const params = { chat_id: chatId };
  if (caption) params.caption = caption;
  let r = await baleCall(spec.method, params, { [spec.field]: file });

  // Bale is pickier than Telegram about some media; fall back to a plain file.
  if (!r.ok && r.error_code === 400 && spec.method !== 'sendDocument' && spec.method !== 'sendPhoto') {
    r = await baleCall('sendDocument', params, { document: new InputFile(bytes, spec.name, { type: spec.mime }) });
  }
  if (!r.ok) return r;
  if (separateText) return sendText(chatId, separateText);
  return r;
}

// Returns { ok: true } or { ok: false, reason } where reason is a key of T.fail.
export async function deliver(baleChatId, m) {
  const source = forwardSource(m);
  const header = source ? T.forwardedFrom(source) : '';

  let r;
  if (typeof m.text === 'string' && m.text.length) {
    r = await sendText(baleChatId, header ? `${header}\n\n${m.text}` : m.text);
  } else if (mediaSpec(m)) {
    r = await sendMedia(baleChatId, m, header);
  } else if (m.location) {
    if (header) {
      r = await sendText(baleChatId, header);
      if (!r.ok) return failure(r);
    }
    r = await baleCall('sendLocation', {
      chat_id: baleChatId,
      latitude: m.location.latitude,
      longitude: m.location.longitude,
    });
    if (r.ok && m.venue && m.venue.title) {
      r = await sendText(baleChatId, [m.venue.title, m.venue.address].filter(Boolean).join('\n'));
    }
  } else if (m.contact) {
    if (header) {
      r = await sendText(baleChatId, header);
      if (!r.ok) return failure(r);
    }
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

function failure(r) {
  if (r.reason) return { ok: false, reason: r.reason };
  return { ok: false, reason: classifyError(r) || 'rejected' };
}
