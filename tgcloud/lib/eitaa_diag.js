// Owner-only EitaaYar diagnostics (/eitaa_diag …) and the CI probe
// (`npx tgcloud run handlers/message '{ __eitaa: true }'`). Tests run only
// against the owner's own approved mirror (their test channel), and only
// with messages the diagnostic itself created. Reports carry timings, HTTP
// codes and error texts with tokens redacted — never a token.

import { api, db, fetch, InputFile } from 'sdk';
import { sql } from 'sdk/db';
import {
  SHARED_TOKEN, RELAY_URL, relayEnabled, eitaaCallOnce, eitaaCall, channelToken, describeFailure, messageIdOf, redact,
  getSetting, updateCaps, eitaaCaps, webCryptoAvailable, simpleModeEnabled, advancedModeEnabled,
} from './eitaa.js';
import { channelRow, refetch, buildParts, processQueue } from './eitaa_mirror.js';
import { OWNER_TELEGRAM_ID } from './config.js';
import { now, sleep } from './util.js';

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAIAAADYYG7QAAAA7UlEQVR42s3CQSsDAACG4e+XODg4ODg4OFArErUiUSsStSJRKxJvikStSNSKRK1I1IpErUjUiuTg4ODg1/gb79OTNj5V0867ajpoqaaTN9V08aKabp5U00NTNb08qqbAvWoGuFXNEA3VFLlRzShXqhnnQjUl6qqZ4lw1M5yqpsyxauapqWaRI9VUOFDNCnuqWaOqmg12VbPFtmp22FRNlQ3V7LOumkNWVVNjWTUnVFRzxpJq6iyo5pI51VxTVk2DWdXcMa2aByZV06SkmmcmVPPKmGpajKjmg6JqvhhWzTeDqvmhXzW/FFTzR5/qPzcpIkRiPeIRAAAAAElFTkSuQmCC';
const BUDGET_MS = 23000;

function b64(s) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const out = [];
  let buf = 0;
  let bits = 0;
  for (const ch of s.replace(/=+$/, '')) {
    buf = (buf << 6) | A.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >> bits) & 255);
    }
  }
  return new Uint8Array(out);
}

const png = () => new InputFile(b64(PNG_B64), 'diag.png', { type: 'image/png' });

// The same small test image, for other diagnostics (/bale_diag fmt).
export const diagPngBytes = () => b64(PNG_B64);

async function say(text) {
  for (let i = 0; i < text.length; i += 3900) {
    await api.sendMessage({ chat_id: OWNER_TELEGRAM_ID, text: text.slice(i, i + 3900), link_preview_options: { is_disabled: true } }).catch(() => null);
  }
}

function line(name, r) {
  if (r.ok) return `✅ ${name}: ${r.ms}ms${messageIdOf(r) ? ' id=' + messageIdOf(r) : ''}`;
  return `❌ ${name}: ${r.ms || '?'}ms ${describeFailure(r)}`;
}

// The owner's own approved mirror, used as the test channel.
async function testMapping() {
  const row = await db.get(sql`
    SELECT * FROM eitaa_channels WHERE owner_tg_id = ${OWNER_TELEGRAM_ID} AND status IN ('active', 'paused')
      AND eitaa_chat_id IS NOT NULL
    ORDER BY CASE mode WHEN 'simple' THEN 0 ELSE 1 END LIMIT 1`);
  if (!row) return null;
  const ch = channelRow(row);
  const token = await channelToken(ch);
  return token ? { ch, token, chat: ch.eitaaChatId } : null;
}

const NO_MAPPING = 'ℹ️ برای آزمایش‌های ارسال، اول کانال تلگرام آزمایشی خودتان را (به‌عنوان مدیر، حالت ساده) به کانال ایتای آزمایشی وصل و تأیید کنید.';

function runtimeCaps() {
  const c = globalThis.crypto;
  return {
    setTimeout: typeof setTimeout === 'function',
    webCrypto: webCryptoAvailable(),
    randomValues: Boolean(c && typeof c.getRandomValues === 'function'),
    BigInt: typeof BigInt === 'function',
    TextEncoder: typeof TextEncoder === 'function',
    btoa: typeof btoa === 'function',
    DataView: typeof DataView === 'function',
    WebAssembly: typeof WebAssembly === 'object',
  };
}

async function timedFetch(url, init) {
  const t = Date.now();
  try {
    const res = await fetch(url, init);
    let bytes = 0;
    let streamed = false;
    try {
      for await (const chunk of res.body) {
        bytes += chunk.length || chunk.byteLength || 0;
        streamed = true;
        if (bytes > 200000) break;
      }
    } catch {
      streamed = false;
    }
    return { ok: true, status: res.status, ms: Date.now() - t, bytes, streamed };
  } catch (e) {
    return { ok: false, ms: Date.now() - t, error: redact(e && e.message).slice(0, 100) };
  }
}

function fetchLine(name, r) {
  return r.ok ? `${name}: HTTP ${r.status} ${r.ms}ms ${r.bytes}B${r.streamed ? ' (stream ok)' : ''}` : `${name}: ❌ ${r.ms}ms ${r.error}`;
}

// ── /eitaa_diag ─────────────────────────────────────────────────────────────

export async function runEitaaDiag() {
  const started = Date.now();
  const left = () => BUDGET_MS - (Date.now() - started);
  const out = ['🔧 تشخیص ایتایار', ''];

  out.push('حالت ساده: ' + (simpleModeEnabled() ? 'فعال' : 'غیرفعال (Secret خالی)') + ' · حالت پیشرفته: ' + (advancedModeEnabled() ? 'فعال' : 'غیرفعال (Secret خالی)'));
  out.push('runtime: ' + JSON.stringify(runtimeCaps()));
  let slept = null;
  if (typeof setTimeout === 'function') {
    const t = Date.now();
    await sleep(200);
    slept = Date.now() - t;
  }
  out.push(`sleep(200): ${slept === null ? 'ممکن نیست' : slept + 'ms'}`);

  out.push('', '— دسترسی از سرور تلگرام —');
  out.push(fetchLine('GET eitaayar.ir (مستقیم)', await timedFetch('https://eitaayar.ir/')));
  out.push(relayEnabled() ? 'رله: ' + JSON.stringify(await relayPing()) : 'رله: تنظیم نشده (EITAA_RELAY_URL / EITAA_RELAY_KEY)');

  if (SHARED_TOKEN) {
    out.push(line('getMe (توکن مشترک)', await eitaaCallOnce(SHARED_TOKEN, 'getMe', {})));
  } else {
    out.push('getMe: توکن مشترک تنظیم نشده');
  }
  const bad = await eitaaCallOnce('bot0:00000000-0000-0000-0000-000000000000', 'getMe', {});
  out.push(`شکل خطای توکن غلط: http=${bad.http} keys=${Object.keys(bad).filter((k) => !['ms', 'http'].includes(k)).join(',')} → ${describeFailure(bad)}`);
  if (SHARED_TOKEN) {
    const badChat = await eitaaCallOnce(SHARED_TOKEN, 'sendMessage', { chat_id: '1', text: 'diag' });
    out.push(`شکل خطای chat_id غلط: http=${badChat.http} → ${badChat.ok ? 'ok?!' : describeFailure(badChat)}`);
  }

  const m = await testMapping();
  out.push('', '— محدودیت‌ها (روی کانال آزمایشی) —');
  if (!m) {
    out.push(NO_MAPPING);
  } else {
    const send = (text, extra) => eitaaCallOnce(m.token, 'sendMessage', { chat_id: m.chat, title: 'tg-diag', text, ...extra });
    const fa = (n) => 'آ'.repeat(n);
    const caps = {};
    if (left() > 5000) {
      const a = await send(fa(4096));
      out.push(line('متن ۴۰۹۶ حرف فارسی', a));
      if (a.ok && left() > 5000) {
        const b = await send(fa(4097));
        out.push(line('متن ۴۰۹۷ حرف', b));
        caps.textLimit = b.ok ? 4097 : 4096;
        if (left() > 5000) {
          // 4096 visible characters plus tags: does the limit count markup?
          const c = await send('<b>' + fa(2048) + '</b><i>' + fa(2048) + '</i>', { parse_mode: 'html' });
          out.push(line('۴۰۹۶ حرف + تگ HTML', c));
          caps.limitCountsMarkup = !c.ok;
        }
      } else if (!a.ok && left() > 5000) {
        const d = await send(fa(2000));
        out.push(line('متن ۲۰۰۰ حرف', d));
        if (d.ok) caps.textLimit = 2000;
      }
    }
    for (const n of [4096, 1024]) {
      if (left() < 6000) break;
      const r = await eitaaCallOnce(m.token, 'sendFile', { chat_id: m.chat, title: 'tg-diag', caption: fa(n) }, png());
      out.push(line(`عکس با کپشن ${n} حرف`, r));
      if (r.ok) {
        caps.captionLimit = n;
        break;
      }
    }
    if (Object.keys(caps).length) await updateCaps(caps);
    out.push('ذخیره شد: ' + JSON.stringify(await eitaaCaps()));
    out.push('👀 در ایتا ببینید: عکس آزمایشی به‌صورت «عکس» نمایش داده شد یا «فایل»؟');
  }

  out.push('', '— تشخیص حذف پست در تلگرام —');
  out.push(...(await deletionProbe()));

  out.push('', `⏱ این اجرا ${Math.round((Date.now() - started) / 100) / 10} ثانیه طول کشید.`);
  await say(out.join('\n'));

  // Safe duration check: keep the run alive up to 27 s (the platform cuts
  // runs near 30 s), then report. Nothing is left half-done if it is cut.
  const target = 27000;
  let beats = 0;
  while (Date.now() - started < target) {
    await db.get(sql`SELECT 1 AS x`);
    beats++;
  }
  await say(`⏱ اجرای این دستور دست‌کم ${Math.round((Date.now() - started) / 1000)} ثانیه زنده ماند (${beats} پرس‌وجوی پایگاه داده). سقف پلتفرم حدود ۳۰ ثانیه است.`);
}

// Does editMessageReplyMarkup tell an existing post from a deleted one?
async function deletionProbe() {
  const row = await db.get(sql`
    SELECT p.tg_channel_id AS ch, max(p.tg_message_id) AS mid FROM eitaa_posts p
    JOIN eitaa_channels c ON c.tg_channel_id = p.tg_channel_id
    WHERE c.owner_tg_id = ${OWNER_TELEGRAM_ID} AND p.status IN ('done', 'partial')
    GROUP BY p.tg_channel_id LIMIT 1`);
  if (!row || !row.mid) return ['ℹ️ هنوز پستی از کانال آزمایشی منتشر نشده؛ بعد از یک پست دوباره اجرا کنید.'];
  const out = [];
  try {
    const me = await api.getMe();
    const bot = await api.getChatMember({ chat_id: row.ch, user_id: me.id });
    out.push(`دسترسی ربات: ${bot.status} edit=${bot.can_edit_messages} delete=${bot.can_delete_messages}`);
  } catch (e) {
    out.push('دسترسی ربات: ' + (e && e.description));
  }
  for (const [name, mid] of [['پست موجود', Number(row.mid)], ['پست ناموجود', Number(row.mid) + 100000]]) {
    try {
      await api.editMessageReplyMarkup({ chat_id: row.ch, message_id: mid });
      out.push(`${name}: ok (!)`);
    } catch (e) {
      out.push(`${name}: ${e.code} ${e.description}`);
    }
  }
  return out;
}

// ── /eitaa_diag fmt ─────────────────────────────────────────────────────────

const FMT_MESSAGES = [
  '1) <b>b</b> · <strong>strong</strong>',
  '2) <i>i</i> · <em>em</em>',
  '3) <u>u</u> · <s>s</s> · <strike>strike</strike> · <del>del</del>',
  '4) <a href="https://eitaa.com">a (link)</a> · <code>code</code>\n<pre>pre line 1\npre line 2</pre>',
  '5) <blockquote>blockquote</blockquote>',
  '6) <tg-spoiler>tg-spoiler</tg-spoiler> · <span class="tg-spoiler">span</span> · esc: &amp; &lt; &gt;',
];

// A visual check only: the tags the bot uses are fixed (eitaa.js), so
// nothing is stored from it.
export async function runFmtDiag() {
  const m = await testMapping();
  if (!m) return say(NO_MAPPING);
  const out = ['🔤 آزمایش تگ‌های HTML — ۶ پیام به کانال آزمایشی فرستاده شد:'];
  for (const text of FMT_MESSAGES) {
    out.push(line(text.slice(0, 2), await eitaaCallOnce(m.token, 'sendMessage', { chat_id: m.chat, title: 'tg-diag-fmt', text, parse_mode: 'html' })));
  }
  out.push('', 'ربات از این تگ‌ها استفاده می‌کند: b, i, code, a (بقیه به متن ساده تبدیل می‌شوند).');
  await say(out.join('\n'));
  return null;
}

// /eitaa_diag fmt2 (and CI __eitaa_fmt2): do literal * _ / in a text break
// Eitaa's HTML formatting, and which escape keeps them literal? Each
// message carries the same formatted baseline plus one variant.
const BASE = '<b>bold</b> <i>italic</i> <a href="https://eitaa.com">link</a> <code>code</code>';
const ZWS = '\u200B';
const FMT2 = [
  ['html', `1) ${BASE}`],
  ['html', `2) ${BASE}\n*x*`],
  ['html', `3) ${BASE}\n_x_`],
  ['html', `4) ${BASE}\n/x/`],
  ['html', `5) ${BASE}\n&#42;x&#42; &#95;x&#95; &#47;x&#47;`],
  ['html', `6) ${BASE}\n*${ZWS}x*${ZWS} _${ZWS}x_${ZWS} /${ZWS}x/${ZWS}`],
  ['html', `7) ${BASE}\n\\*x\\* \\_x\\_ \\/x\\/`],
  ['markdown', '8) **bold** __italic__ [link](https://eitaa.com) `code`'],
  [null, '9) **bold** __italic__ [link](https://eitaa.com) `code` *x* _x_ /x/'],
];

// fmt3: is formatting misplaced after line breaks? Your test post, as the
// bot renders it, sent with different line-break forms.
const POST_LINES = ['*test*', '_test_', '/test/', 'link', 'normal', 'bold', 'italic', 'code'];
function postHtml(nl, from) {
  const lines = POST_LINES.slice(from || 0);
  const wrap = { link: (t) => `<a href="https://eitaa.com">${t}</a>`, bold: (t) => `<b>${t}</b>`, italic: (t) => `<i>${t}</i>`, code: (t) => `<code>${t}</code>` };
  return lines.map((l) => (wrap[l] ? wrap[l](l) : l)).join(nl);
}
const FMT3 = [
  `1) x\n<b>bold</b>`,
  `2) x\nx\nx\n<b>bold</b> <i>italic</i> <code>code</code>`,
  `3) \n` + postHtml('\n'),
  `4) <br>` + postHtml('<br>'),
  `5) \r\n` + postHtml('\r\n'),
  `6) \n` + postHtml('\n', 3),
  `7) ` + postHtml(' '),
];

export async function runFmt3Diag() {
  const m = await testMapping();
  if (!m) return { ok: false, error: 'no test mapping' };
  const out = [];
  for (const text of FMT3) {
    const r = await eitaaCallOnce(m.token, 'sendMessage', { chat_id: m.chat, title: 'tg-diag-fmt3', text, parse_mode: 'html' });
    out.push(`${text.slice(0, 2)} ${r.ok ? 'ok' : describeFailure(r).slice(0, 80)}`);
  }
  return { ok: true, sent: out };
}

export async function runFmt2Diag() {
  const m = await testMapping();
  if (!m) return { ok: false, error: 'no test mapping' };
  const out = [];
  for (const [mode, text] of FMT2) {
    const params = { chat_id: m.chat, title: 'tg-diag-fmt2', text };
    if (mode) params.parse_mode = mode;
    const r = await eitaaCallOnce(m.token, 'sendMessage', params);
    out.push(`${text.slice(0, 2)} ${r.ok ? 'ok' : describeFailure(r).slice(0, 80)}`);
  }
  return { ok: true, sent: out };
}

// ── /eitaa_diag methods ─────────────────────────────────────────────────────

const CAP_KEYS = { e: 'editMethod', c: 'editCaptionMethod', d: 'deleteMethod' };

export async function runMethodsDiag() {
  const m = await testMapping();
  if (!m) return say(NO_MAPPING);
  const started = Date.now();
  const call = (method, params, file) => eitaaCallOnce(m.token, method, { chat_id: m.chat, ...params }, file);
  const out = ['🧪 بررسی متدهای مستندنشده (فقط روی پیام‌های خود این آزمایش):'];

  const baseline = await call('thisMethodDoesNotExist', {});
  const sig = (r) => `${r.ok}|${r.http}|${r.error_code}|${r.description}`;
  out.push('پاسخ متد ناموجود: ' + describeFailure(baseline));
  const verdict = (name, r) => {
    if (r.ok) return `✅ ${name}: ok ${JSON.stringify(r.result).slice(0, 80)}`;
    return sig(r) === sig(baseline) ? `➖ ${name}: متد پیدا نشد` : `⚠️ ${name}: ${describeFailure(r)}`;
  };

  const text = await call('sendMessage', { text: '🧪 diag: پیام آزمایشی متدها (قبل از ویرایش)', title: 'tg-diag-methods' });
  const textId = messageIdOf(text);
  const file = await call('sendFile', { caption: '🧪 diag: کپشن قبل از ویرایش', title: 'tg-diag-methods' }, png());
  const fileId = messageIdOf(file);
  out.push(line('sendMessage', text), line('sendFile', file));
  if (!textId) {
    await say(out.join('\n'));
    return null;
  }

  const ask = [];
  const probes = [
    ['editMessageText', { message_id: textId, text: '🧪 diag: ویرایش شد با editMessageText' }, 'e'],
    ['editMessage', { message_id: textId, text: '🧪 diag: ویرایش شد با editMessage' }, 'e'],
    ['editMessageCaption', { message_id: fileId || textId, caption: '🧪 diag: کپشن ویرایش شد' }, 'c'],
    ['sendMediaGroup', { media: '[]' }],
    ['sendAlbum', {}],
    ['sendPhoto', {}],
    ['sendVideo', {}],
    ['sendDocument', {}],
    ['getChat', {}],
    ['getUpdates', {}],
    ['deleteMessages', { message_ids: '[]' }],
    ['deleteMessage', { message_id: textId }, 'd'],
  ];
  for (const [method, params, key] of probes) {
    if (Date.now() - started > BUDGET_MS) {
      out.push('⏳ وقت تمام شد؛ بقیه بررسی نشد.');
      break;
    }
    const r = await call(method, params);
    out.push(verdict(method, r));
    if (r.ok && key) ask.push([key, method]);
  }
  await say(out.join('\n'));
  for (const [key, method] of ask) {
    const q = key === 'd' ? 'آیا پیام آزمایشی واقعاً از کانال ایتا حذف شد؟' : 'آیا پیام آزمایشی در ایتا واقعاً ویرایش شد؟';
    await api.sendMessage({
      chat_id: OWNER_TELEGRAM_ID,
      text: `${method}: ${q}\n(اگر «بله» بزنید، ربات از این به بعد از این متد استفاده می‌کند.)`,
      reply_markup: { inline_keyboard: [[
        { text: '✅ بله', callback_data: `dg:m:${key}:${method}` },
        { text: '❌ نه', callback_data: `dg:m:${key}:-` },
      ]] },
    }).catch(() => null);
  }
  return null;
}

export async function onMethodButton(cq) {
  const [, , key, method] = cq.data.split(':');
  const capKey = CAP_KEYS[key];
  if (!capKey) return;
  const value = method && method !== '-' && /^[A-Za-z]+$/.test(method) ? method : null;
  await updateCaps({ [capKey]: value });
  await api.editMessageText({
    chat_id: cq.message.chat.id, message_id: cq.message.message_id,
    text: value ? `✅ ${capKey} = ${value} ذخیره شد.` : `ثبت شد: ${capKey} استفاده نمی‌شود.`,
  }).catch(() => null);
}

// ── /eitaa_diag size ────────────────────────────────────────────────────────

export async function runSizeDiag(arg) {
  const m = await testMapping();
  if (!m) return say(NO_MAPPING);
  const started = Date.now();
  const sizes = /^\d+$/.test(arg || '') ? [Number(arg)] : [1, 5, 15];
  for (const mb of sizes) {
    if (Date.now() - started > 12000) {
      await say(`⏳ برای ${mb} مگابایت وقت نماند؛ جداگانه اجرا کنید: /eitaa_diag size ${mb}`);
      break;
    }
    const bytes = new Uint8Array(mb * 1024 * 1024);
    for (let i = 0; i < bytes.length; i += 4096) bytes[i] = i & 255;
    const r = await eitaaCallOnce(m.token, 'sendFile', { chat_id: m.chat, title: 'tg-diag-size', caption: `diag ${mb}MB` },
      new InputFile(bytes, `diag-${mb}mb.bin`, { type: 'application/octet-stream' }));
    await say(line(`فایل ${mb} مگابایت`, r));
  }
  return null;
}

// ── Phase B: the Eitaa web gateway (no login, no credentials) ───────────────
// One unauthenticated help.getConfig inside eitaaObject (token and imei
// empty), only to see whether the gateway answers the platform at all.

function tlInt(v) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, v, true);
  return [...b];
}

function tlBytes(bytes) {
  const out = bytes.length < 254 ? [bytes.length, ...bytes] : [254, bytes.length & 255, (bytes.length >> 8) & 255, (bytes.length >> 16) & 255, ...bytes];
  while (out.length % 4) out.push(0);
  return out;
}

export async function gatewayProbe() {
  const inner = tlInt(0xc4f9186b | 0); // help.getConfig
  const body = new Uint8Array([
    ...tlInt(0x7abe77ed | 0), // eitaaObject
    ...tlBytes([]), ...tlBytes([]), ...tlBytes(inner), ...tlInt(133), ...tlInt(0),
  ]);
  const out = {};
  for (const url of ['https://sajad.eitaa.ir/eitaa/', 'https://alzheimer.eitaa.com/eitaa/']) {
    const t = Date.now();
    try {
      const res = await fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'application/octet-stream' } });
      const chunks = [];
      let n = 0;
      for await (const c of res.body) {
        chunks.push(c);
        n += c.length || c.byteLength || 0;
        if (n > 65536) break;
      }
      const first = chunks.length ? new Uint8Array(chunks[0]) : new Uint8Array(0);
      const head = first.length >= 4 ? (new DataView(first.buffer, first.byteOffset, 4).getUint32(0, true) >>> 0).toString(16) : '';
      out[url] = { http: res.status, ms: Date.now() - t, bytes: n, firstConstructor: head ? '0x' + head : null };
    } catch (e) {
      out[url] = { error: redact(e && e.message).slice(0, 100), ms: Date.now() - t };
    }
  }
  return out;
}

// The relay's own check: can Cloudflare reach eitaayar.ir right now?
async function relayPing() {
  const t = Date.now();
  try {
    const res = await fetch(RELAY_URL + '/ping');
    const data = JSON.parse(await res.text());
    return { http: res.status, ms: Date.now() - t, eitaayar: data.eitaayar, ok: data.ok };
  } catch (e) {
    return { ok: false, ms: Date.now() - t, error: redact(e && e.message).slice(0, 100) };
  }
}

// CI probe (__eitaa_render): the owner's last mirrored post, re-read from
// Telegram, and what the bot builds from it — as structure only: entity
// types/offsets and the parts with every letter and digit masked.
export async function runEitaaRender() {
  const row = await db.get(sql`
    SELECT p.tg_channel_id AS ch, p.tg_message_id AS id FROM eitaa_posts p
    JOIN eitaa_channels c ON c.tg_channel_id = p.tg_channel_id
    WHERE c.owner_tg_id = ${OWNER_TELEGRAM_ID} AND p.kind = 'post' AND p.status IN ('done', 'partial')
    ORDER BY p.tg_message_id DESC LIMIT 1`);
  if (!row) return { ok: false, error: 'no post' };
  const ch = channelRow(await db.get(sql`SELECT * FROM eitaa_channels WHERE tg_channel_id = ${row.ch}`));
  const f = await refetch(ch, Number(row.id));
  if (!f.ok) return { ok: false, refetch: f };
  const m = f.message;
  const mask = (t) => String(t || '').replace(/[\p{L}\p{N}]/gu, 'x');
  const { parts, issues } = buildParts(m, await eitaaCaps(), { link: 'L' });
  return {
    ok: true, id: row.id, textLength: (m.text || m.caption || '').length,
    textShape: mask(m.text || m.caption),
    entities: (m.entities || m.caption_entities || []).map((e) => `${e.type}@${e.offset}+${e.length}`),
    parts: parts.map((p) => ({ type: p.type, html: p.html, shape: mask(p.text || (p.caption && p.caption.text)) })),
    issues: [...issues],
  };
}

// CI probe (__eitaa_resend): sends the owner's last mirrored post again
// through the real mirror path (queue → re-read → send), to compare it with
// the diagnostic messages in the same app.
export async function runEitaaResend() {
  const row = await db.get(sql`
    SELECT p.tg_channel_id AS ch, p.tg_message_id AS id FROM eitaa_posts p
    JOIN eitaa_channels c ON c.tg_channel_id = p.tg_channel_id
    WHERE c.owner_tg_id = ${OWNER_TELEGRAM_ID} AND p.kind = 'post' AND p.status IN ('done', 'partial')
    ORDER BY p.tg_message_id DESC LIMIT 1`);
  if (!row) return { ok: false, error: 'no post' };
  await db.run(sql`
    UPDATE eitaa_posts SET status = 'queued', parts_done = 0, eitaa_ids = '[]', attempts = 0
    WHERE tg_channel_id = ${row.ch} AND tg_message_id = ${row.id}`);
  const status = await processQueue(Number(row.ch), { deadline: Date.now() + 10000, waitMs: 3000 });
  const after = await db.get(sql`SELECT status, issues, last_error FROM eitaa_posts WHERE tg_channel_id = ${row.ch} AND tg_message_id = ${row.id}`);
  return { ok: true, id: row.id, queue: status, after };
}

// CI probe (__eitaa_state): stored findings and the outcome of the owner's
// last mirrored posts — ids, statuses and issue codes only (public logs).
export async function runEitaaState() {
  const rows = await db.all(sql`
    SELECT p.tg_message_id AS id, p.kind, p.status, p.issues, p.last_error, p.parts_done
    FROM eitaa_posts p JOIN eitaa_channels c ON c.tg_channel_id = p.tg_channel_id
    WHERE c.owner_tg_id = ${OWNER_TELEGRAM_ID} ORDER BY p.updated_at DESC LIMIT 8`);
  return { caps: await getSetting('caps', null), baleFmt: await getSetting('bale_fmt', null), posts: rows };
}

// CI probe: reachability, getMe and runtime facts. Output is public in CI
// logs, so it carries no ids, tokens or contents.
export async function runEitaaCiProbe() {
  const out = { at: now(), runtime: runtimeCaps(), simpleMode: simpleModeEnabled(), advancedMode: advancedModeEnabled() };
  out.site = await timedFetch('https://eitaayar.ir/');
  out.relay = relayEnabled() ? await relayPing() : 'not configured';
  if (relayEnabled()) {
    // Security check: the relay must refuse a request without a signature.
    try {
      const res = await fetch(RELAY_URL + '/api/bot0:00000000-0000-0000-0000-000000000000/getMe', { method: 'POST', body: fetch.body.form({}) });
      out.relayUnsigned = res.status === 403 ? 'rejected (403)' : 'NOT rejected: HTTP ' + res.status;
    } catch (e) {
      out.relayUnsigned = 'error: ' + redact(e && e.message).slice(0, 80);
    }
  }
  // What else can (not) be reached, to tell a block on Eitaa from a
  // general problem with Iranian hosts.
  out.reach = {};
  for (const url of [
    'https://example.com/', 'https://tapi.bale.ai/', 'https://ble.ir/', 'https://eitaa.com/', 'https://web.eitaa.com/',
    'https://www.aparat.com/', 'https://www.digikala.com/', 'https://2.189.58.58/', 'http://eitaayar.ir/', 'https://api.eitaayar.ir/',
  ]) {
    const r = await timedFetch(url);
    out.reach[url] = r.ok ? `${r.status} ${r.ms}ms` : `fail ${r.ms}ms ${r.error}`;
  }
  if (SHARED_TOKEN) {
    const r = await eitaaCall(SHARED_TOKEN, 'getMe', {});
    out.getMe = { ok: r.ok, ms: r.ms, http: r.http, error: r.ok ? undefined : describeFailure(r).slice(0, 100) };
  }
  const bad = await eitaaCallOnce('bot0:00000000-0000-0000-0000-000000000000', 'getMe', {});
  out.badTokenShape = { http: bad.http, keys: Object.keys(bad).filter((k) => k !== 'ms').sort(), error_code: bad.error_code, description: String(bad.description || '').slice(0, 80) };
  // What the plain-HTTP answer says (a firewall page?). Bad token only.
  out.httpBodies = {};
  for (const url of ['http://eitaayar.ir/', 'http://eitaayar.ir/api/bot0:00000000-0000-0000-0000-000000000000/getMe']) {
    try {
      const res = await fetch(url);
      const headers = {};
      for (const k of ['server', 'content-type', 'via', 'x-cache', 'cf-ray', 'retry-after']) if (res.headers.has(k)) headers[k] = res.headers.get(k);
      out.httpBodies[url.replace(/bot0:[0-9-]+/, 'bot0:…')] = { status: res.status, headers, body: redact((await res.text()).replace(/\s+/g, ' ')).slice(0, 300) };
    } catch (e) {
      out.httpBodies[url] = { error: redact(e && e.message).slice(0, 100) };
    }
  }
  out.gateway = await gatewayProbe();
  out.caps = await eitaaCaps();
  return out;
}
