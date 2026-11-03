// Telegram text + entities → Bale text. Bale has no parse_mode: every text
// it receives is rendered as Markdown. Documented (docs.bale.ai) and seen
// live: bold between single asterisks, italic between underscores, each
// needing a space (or line start/end) before the opening and after the
// closing marker; links as [text](url). Other Telegram formats (underline,
// strikethrough, code, quote, spoiler) have no Bale form and go out plain.
// The owner's /bale_diag fmt answers can change the markers or allow
// punctuation next to them. Markers the user typed themselves are left as
// they are: Bale may format them, which is fine.

import { AUTO_TYPES, normalizeEntities, trimSpan, chunkRanges } from './entities.js';

export const DEFAULT_BALE_FORMAT = {
  answered: false,
  bold: '*', // '*' | '**' | null
  italic: '_', // '_' | '__' | null
  link: true,
  punct: false, // markers work next to punctuation
  glued: false, // markers work glued to letters
  zwnj: false, // markers work next to a ZWNJ (نیم‌فاصله)
  caption: true, // captions are parsed like texts
};

let current = DEFAULT_BALE_FORMAT;

export function setBaleFormat(f) {
  current = { ...DEFAULT_BALE_FORMAT, ...(f || {}) };
}

export function baleFormat() {
  return current;
}

function safeUrl(url) {
  if (typeof url !== 'string' || !/^https?:\/\/\S+$/i.test(url)) return null;
  return url.replace(/\(/g, '%28').replace(/\)/g, '%29');
}

// Picks the spans that can be written as Bale Markdown (Markdown can't nest
// or overlap them): links first (the URL is information), then bold, then
// italic. Returns { spans, issues }.
function baleSpans(text, entities, fmt) {
  const issues = new Set();
  const candidates = [];
  for (const s of normalizeEntities(text, entities)) {
    if (AUTO_TYPES.has(s.type)) continue;
    if (s.type === 'text_link' && fmt.link && safeUrl(s.url)) candidates.push({ ...s, prio: 0, href: safeUrl(s.url) });
    else if (s.type === 'bold' && fmt.bold) candidates.push({ ...s, prio: 1, marker: fmt.bold });
    else if (s.type === 'italic' && fmt.italic) candidates.push({ ...s, prio: 2, marker: fmt.italic });
    else issues.add(s.type);
  }
  candidates.sort((a, b) => a.prio - b.prio || a.start - b.start);

  const okChar = (ch) => ch === undefined || /\s/.test(ch) || fmt.glued
    || (fmt.punct && /[\p{P}\p{S}]/u.test(ch)) || (fmt.zwnj && ch === '‌');
  const chosen = [];
  for (const c0 of candidates) {
    const c = trimSpan(text, c0);
    if (!c) continue;
    const clash = chosen.some((s) => c.start < s.end && s.start < c.end);
    // Links come first, so a marker span next to a link (or another marker
    // span) is the one that fails the spacing rule.
    const touches = chosen.some((s) => s.end === c.start || s.start === c.end);
    const spacing = c.href ? true : okChar(text[c.start - 1]) && okChar(text[c.end]) && !touches;
    if (clash || !spacing) {
      issues.add(c.type);
      continue;
    }
    chosen.push(c);
  }
  chosen.sort((a, b) => a.start - b.start);
  return { spans: chosen, issues };
}

function renderRange(text, sel, from, to, withFormat) {
  const { spans } = sel;
  const literal = (a, b) => text.slice(a, b);
  let out = '';
  let pos = from;
  if (withFormat) {
    for (const s0 of spans) {
      if (s0.end <= from || s0.start >= to) continue;
      const s = trimSpan(text, { ...s0, start: Math.max(s0.start, from), end: Math.min(s0.end, to) });
      if (!s) continue;
      out += literal(pos, s.start);
      const inner = literal(s.start, s.end);
      out += s.href ? `[${inner}](${s.href})` : s.marker + inner + s.marker;
      pos = s.end;
    }
  }
  return out + literal(pos, to);
}

// Text (or caption, with { caption: true }) → chunks of at most `max`
// characters as sent: [{ text, plain }] where `plain` is the same chunk
// without formatting (sent if Bale refuses the first). Also `issues`.
export function baleChunks(text, entities, max, { caption } = {}) {
  text = String(text || '');
  const fmt = caption && !current.caption ? { ...current, link: false, bold: null, italic: null } : current;
  const sel = baleSpans(text, entities, fmt);
  const chunks = chunkRanges(text, max, (from, to) => {
    const out = renderRange(text, sel, from, to, true);
    return { text: out, size: out.length };
  }).map((c) => ({ text: c.text, plain: renderRange(text, sel, c.from, c.to, false) }));
  return { chunks, issues: sel.issues };
}

export function formatChunks(text, entities, max, opts) {
  return baleChunks(text, entities, max, opts).chunks;
}

// The whole text as one Bale string.
export function toBaleMarkdown(text, entities, opts) {
  const c = formatChunks(text, entities, Number.MAX_SAFE_INTEGER, opts)[0];
  return c ? c.text : '';
}
