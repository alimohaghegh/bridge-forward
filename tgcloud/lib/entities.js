// Shared handling of Telegram message entities (text and captions), used by
// the Eitaa HTML renderer (eitaa_html.js) and the Bale Markdown renderer
// (format.js). Offsets are UTF-16 code units, as in Telegram and JS strings,
// so an emoji counts as 2 and slicing the string by offsets is exact.

// Detected by the apps from the text itself: plain text loses nothing.
export const AUTO_TYPES = new Set(['mention', 'hashtag', 'cashtag', 'bot_command', 'url', 'email', 'phone_number']);

// Valid entities as spans { type, start, end, url, index }, clamped to the
// text and sorted outer-first (earlier start, then longer, then original
// order), which is the order nested tags must open in.
export function normalizeEntities(text, entities) {
  const spans = [];
  (entities || []).forEach((e, index) => {
    if (!e || typeof e.offset !== 'number' || typeof e.length !== 'number') return;
    const start = Math.max(0, e.offset);
    const end = Math.min(text.length, e.offset + e.length);
    if (start >= end) return;
    spans.push({ type: e.type, start, end, url: e.url, language: e.language, index });
  });
  return mergeTouching(spans);
}

// Telegram may split one formatted run into touching entities of the same
// type (e.g. bold over a hashtag, then bold over the rest). Rendered apart,
// they give "</b><b>", which EitaaYar prints as text and Bale's markers
// can't express. Same-type spans that touch or overlap are joined (links
// only when the URL is the same).
function mergeTouching(spans) {
  spans.sort((a, b) => a.start - b.start || b.end - a.end || a.index - b.index);
  const out = [];
  for (const s of spans) {
    const prev = out.find((p) => p.type === s.type && p.url === s.url && !AUTO_TYPES.has(s.type)
      && s.start <= p.end && s.end >= p.start);
    if (prev) {
      prev.start = Math.min(prev.start, s.start);
      prev.end = Math.max(prev.end, s.end);
    } else {
      out.push({ ...s });
    }
  }
  out.sort((a, b) => a.start - b.start || b.end - a.end || a.index - b.index);
  return out;
}

// Moves a span's edges inward past whitespace (markers must touch text).
export function trimSpan(text, s) {
  let start = s.start;
  let end = s.end;
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  return start < end ? { ...s, start, end } : null;
}

// Renders text[from, to) with possibly nested or overlapping spans as
// properly nested markup: the text is cut at every span boundary and, between
// boundaries, open tags are closed down to the common prefix and reopened.
// hooks: { open(span), close(span), text(string) }.
export function renderNested(text, spans, from, to, hooks) {
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
    for (let k = stack.length - 1; k >= keep; k--) out += hooks.close(stack[k]);
    for (let k = keep; k < want.length; k++) out += hooks.open(want[k]);
    stack = want;
    out += hooks.text(text.slice(a, b), a);
  }
  for (let k = stack.length - 1; k >= 0; k--) out += hooks.close(stack[k]);
  return out;
}

// A good place to end a chunk at or before `end`: after a blank line, else a
// line break, else a space; never inside a surrogate pair.
export function cutPoint(text, from, end) {
  const min = from + Math.floor((end - from) * 0.3);
  for (const sep of ['\n\n', '\n', ' ']) {
    const at = text.lastIndexOf(sep, end - sep.length);
    if (at >= min) return at + sep.length;
  }
  const code = text.charCodeAt(end - 1);
  return code >= 0xd800 && code <= 0xdbff ? end - 1 : end;
}

// Splits text into ranges whose rendering fits `limit`. render(from, to)
// returns { text, size }. Markup is rendered per range, so a chunk never
// ends inside a tag. Returns [{ text, from, to }].
export function chunkRanges(text, limit, render) {
  const out = [];
  let pos = 0;
  while (pos < text.length) {
    let end = text.length;
    let r = render(pos, end);
    let guard = 0;
    while (r.size > limit && guard++ < 40) {
      const target = Math.max(1, Math.floor((end - pos) * Math.min(0.95, limit / r.size)));
      end = cutPoint(text, pos, pos + target);
      if (end <= pos) end = pos + 1;
      r = render(pos, end);
    }
    if (r.text.trim().length) out.push({ text: r.text, from: pos, to: end });
    pos = end;
  }
  return out;
}
