// Telegram text formatting → Bale Markdown: bold becomes *text* and italic
// becomes _text_. Other entities are dropped (plain text).

const MARKERS = { bold: '*', italic: '_' };
const WORD_CHAR = /[\p{L}\p{N}]/u;
const SPACE = /\s/;

// Applies bold/italic entities to `text`. Offsets are UTF-16 units, as in
// Telegram and JS strings.
export function toBaleMarkdown(text, entities) {
  const spans = [];
  for (const e of entities || []) {
    const marker = MARKERS[e.type];
    if (!marker) continue;
    let start = e.offset;
    let end = e.offset + e.length;
    // Bale needs the markers right next to the text: move spaces outside.
    while (start < end && SPACE.test(text[start])) start++;
    while (end > start && SPACE.test(text[end - 1])) end--;
    if (start < end) spans.push({ start, end, marker });
  }
  if (!spans.length) return text;

  // Inserts per position: closing markers first (inner before outer), then
  // opening markers (outer before inner).
  const at = new Map();
  const add = (pos, kind, span) => {
    if (!at.has(pos)) at.set(pos, []);
    at.get(pos).push({ kind, span });
  };
  for (const s of spans) {
    add(s.start, 'open', s);
    add(s.end, 'close', s);
  }

  let out = '';
  for (let i = 0; i <= text.length; i++) {
    const list = at.get(i);
    if (list) {
      const closes = list.filter((x) => x.kind === 'close').sort((a, b) => b.span.start - a.span.start);
      const opens = list.filter((x) => x.kind === 'open').sort((a, b) => b.span.end - a.span.end);
      let ins = closes.map((x) => x.span.marker).join('');
      // Markdown markers glued to a letter don't render: keep a space there.
      if (closes.length && i < text.length && WORD_CHAR.test(text[i]) && !opens.length) ins += ' ';
      if (opens.length) {
        if (i > 0 && WORD_CHAR.test(text[i - 1]) && !closes.length) ins += ' ';
        ins += opens.map((x) => x.span.marker).join('');
      }
      out += ins;
    }
    if (i < text.length) out += text[i];
  }
  return out;
}

// Splits text into ranges of at most `max` UTF-16 units, preferring line and
// word boundaries. Returns [start, end) pairs into the original text.
export function splitRanges(text, max) {
  const ranges = [];
  let pos = 0;
  while (text.length - pos > max) {
    const window = text.slice(pos, pos + max);
    let cut = window.lastIndexOf('\n');
    if (cut < max * 0.5) cut = window.lastIndexOf(' ');
    if (cut < max * 0.5) cut = max;
    // Never split a surrogate pair.
    const code = text.charCodeAt(pos + cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    ranges.push([pos, pos + cut]);
    pos += cut;
    if (text[pos] === '\n' || text[pos] === ' ') pos++;
  }
  if (pos < text.length) ranges.push([pos, text.length]);
  return ranges;
}

// Chunks of `text` (each from at most `max` source characters) as
// { text, plain }: Bale Markdown, and the same chunk without formatting
// (a fallback if Bale refuses the Markdown).
export function formatChunks(text, entities, max) {
  return splitRanges(text, max).map(([start, end]) => {
    const local = [];
    for (const e of entities || []) {
      const s = Math.max(e.offset, start);
      const t = Math.min(e.offset + e.length, end);
      if (s < t) local.push({ type: e.type, offset: s - start, length: t - s });
    }
    const plain = text.slice(start, end);
    return { text: toBaleMarkdown(plain, local), plain };
  });
}
