// Telegram text + entities → HTML for EitaaYar (parse_mode=html).
//
// Offsets are UTF-16 units, as in Telegram and JS strings. Entities may nest
// or even overlap: the text is cut at every entity boundary and, between
// boundaries, the open tags are adjusted (closed down to the common prefix,
// then reopened), so the output is always well nested. Entity types without
// a working tag become plain text and are reported as issues.

// Which HTML tags can carry each entity type, in order of preference.
const TAG_OPTIONS = {
  bold: ['b', 'strong'],
  italic: ['i', 'em'],
  underline: ['u'],
  strikethrough: ['s', 'strike', 'del'],
  code: ['code'],
  pre: ['pre'],
  text_link: ['a'],
  blockquote: ['blockquote'],
  expandable_blockquote: ['blockquote'],
  spoiler: ['tg-spoiler', 'span'],
};

// Detected automatically from the text itself: plain text loses nothing.
const PLAIN_TYPES = new Set(['mention', 'hashtag', 'cashtag', 'bot_command', 'url', 'email', 'phone_number']);

export function escapeText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s) {
  return escapeText(s).replace(/"/g, '&quot;');
}

function safeUrl(url) {
  return typeof url === 'string' && /^https?:\/\/\S+$/i.test(url) ? url : null;
}

// Entities that can be rendered with `tags`, as spans { start, end, open,
// close }, plus the set of entity types that had to be dropped.
function spansOf(text, entities, tags) {
  const allowed = new Set(tags);
  const spans = [];
  const issues = new Set();
  (entities || []).forEach((e, index) => {
    if (!e || typeof e.offset !== 'number' || typeof e.length !== 'number') return;
    const start = Math.max(0, e.offset);
    const end = Math.min(text.length, e.offset + e.length);
    if (start >= end) return;
    if (PLAIN_TYPES.has(e.type)) return;
    const tag = (TAG_OPTIONS[e.type] || []).find((t) => allowed.has(t));
    if (!tag) {
      issues.add(e.type);
      return;
    }
    let open = `<${tag}>`;
    if (tag === 'a') {
      const url = safeUrl(e.url);
      if (!url) {
        issues.add('text_link');
        return;
      }
      open = `<a href="${escapeAttr(url)}">`;
    }
    if (tag === 'span') open = '<span class="tg-spoiler">';
    spans.push({ start, end, open, close: `</${tag}>`, index });
  });
  // Outer first: earlier start, then longer, then original order.
  spans.sort((a, b) => a.start - b.start || b.end - a.end || a.index - b.index);
  return { spans, issues };
}

// HTML for text[from, to) with the entities clipped to that range.
function renderRange(text, spans, from, to) {
  const local = spans
    .map((s) => ({ ...s, start: Math.max(s.start, from), end: Math.min(s.end, to) }))
    .filter((s) => s.start < s.end);
  const cuts = new Set([from, to]);
  for (const s of local) {
    cuts.add(s.start);
    cuts.add(s.end);
  }
  const points = [...cuts].sort((a, b) => a - b);

  let out = '';
  let stack = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    const want = local.filter((s) => s.start <= a && s.end >= b);
    let keep = 0;
    while (keep < stack.length && keep < want.length && stack[keep] === want[keep]) keep++;
    for (let k = stack.length - 1; k >= keep; k--) out += stack[k].close;
    for (let k = keep; k < want.length; k++) out += want[k].open;
    stack = want;
    out += escapeText(text.slice(a, b));
  }
  for (let k = stack.length - 1; k >= 0; k--) out += stack[k].close;
  return out;
}

// A good place to end a chunk at or before `end`: after a blank line, else a
// line break, else a space, never inside a surrogate pair.
function cutPoint(text, from, end) {
  const min = from + Math.floor((end - from) * 0.3);
  for (const sep of ['\n\n', '\n', ' ']) {
    const at = text.lastIndexOf(sep, end - sep.length);
    if (at >= min) return at + sep.length;
  }
  const code = text.charCodeAt(end - 1);
  return code >= 0xd800 && code <= 0xdbff ? end - 1 : end;
}

// Converts a message text (or caption) into chunks that each fit `limit`.
// opts: { tags, limit, countMarkup (limit applies to the HTML source),
//         escapesOk (Eitaa decodes &amp; &lt; &gt;), prefix: { html, plain } }
// Returns { chunks: [{ text, html }], issues: Set<entity type> }: `html`
// says whether the chunk must be sent with parse_mode=html. Text without
// any formatting goes out plain (nothing to escape, nothing to break).
export function toEitaaChunks(text, entities, opts) {
  text = String(text || '');
  const prefix = opts.prefix || null;
  const { spans, issues } = spansOf(text, entities, opts.tags);
  let useHtml = spans.length > 0 || Boolean(prefix && prefix.html !== escapeText(prefix.plain));
  if (useHtml && !opts.escapesOk && /[&<>]/.test(text)) {
    // Eitaa would show "&amp;" literally: keep the characters, lose the format.
    useHtml = false;
    for (const s of spans) issues.add('format');
  }

  const measure = (s, plain) => (opts.countMarkup === false ? plain.length : s.length);
  const render = (from, to, first) => {
    const plain = text.slice(from, to);
    const body = useHtml ? renderRange(text, spans, from, to) : plain;
    const pre = first && prefix ? (useHtml ? prefix.html : prefix.plain) : '';
    const plainPre = first && prefix ? prefix.plain : '';
    return { text: pre + body, size: measure(pre + body, plainPre + plain) };
  };

  const chunks = [];
  let pos = 0;
  let first = true;
  if (!text.length && prefix) return { chunks: [{ text: useHtml ? prefix.html : prefix.plain, html: useHtml }], issues };
  while (pos < text.length) {
    let end = text.length;
    let r = render(pos, end, first);
    let guard = 0;
    while (r.size > opts.limit && guard++ < 40) {
      const target = Math.max(1, Math.floor((end - pos) * Math.min(0.95, opts.limit / r.size)));
      end = cutPoint(text, pos, pos + target);
      if (end <= pos) end = pos + 1;
      r = render(pos, end, first);
    }
    if (r.text.trim().length) chunks.push({ text: r.text, html: useHtml });
    pos = end;
    first = false;
  }
  return { chunks, issues };
}

// Single piece (captions): the HTML and its size, or null when it is longer
// than `limit`.
export function toEitaaCaption(text, entities, opts) {
  const { chunks, issues } = toEitaaChunks(text, entities, { ...opts, limit: Number.MAX_SAFE_INTEGER });
  const one = chunks[0] || { text: '', html: false };
  const size = opts.countMarkup === false ? String(text || '').length + (opts.prefix ? opts.prefix.plain.length : 0) : one.text.length;
  return { caption: one, fits: size <= opts.limit, issues };
}
