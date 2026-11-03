// Telegram text + entities → Bale text. Bale has no parse_mode: every text
// it receives is rendered as Markdown. Documented (docs.bale.ai): bold
// between asterisks, italic between underscores, each needing a space before
// the opening and after the closing marker; links as [text](url).
// Undocumented details (single or double markers, punctuation, captions,
// how to show a literal marker) come from the owner's /bale_diag fmt answers;
// until then only links are formatted and everything else is plain.
//
// Because Bale parses everything, characters the user typed (*x*, _x_,
// [a](b), `x`) are escaped so they stay literal: by default a zero-width
// space (U+200B) after each marker character, or a backslash if the
// diagnostic showed that works. Auto-detected entities (urls, mentions…) are
// left untouched so they stay clickable.

import { AUTO_TYPES, normalizeEntities, trimSpan, chunkRanges } from './entities.js';

export const DEFAULT_BALE_FORMAT = {
  answered: false,
  bold: null, // '*' | '**' | null
  italic: null, // '_' | '__' | null
  link: true,
  punct: false, // markers work next to punctuation
  glued: false, // markers work glued to letters
  zwnj: false, // markers work next to a ZWNJ (نیم‌فاصله)
  escape: 'zwsp', // 'zwsp' | 'backslash'
  caption: true, // captions are parsed like texts
};

let current = DEFAULT_BALE_FORMAT;

export function setBaleFormat(f) {
  current = { ...DEFAULT_BALE_FORMAT, ...(f || {}) };
}

export function baleFormat() {
  return current;
}

const SPECIAL = /[*_[\]`~]/g;

function escapeLiteral(s, method) {
  return method === 'backslash' ? s.replace(SPECIAL, '\\$&') : s.replace(SPECIAL, '$&​');
}

function safeUrl(url) {
  if (typeof url !== 'string' || !/^https?:\/\/\S+$/i.test(url)) return null;
  return url.replace(/\(/g, '%28').replace(/\)/g, '%29');
}

// Picks the spans that can be written as Bale Markdown (Markdown can't nest
// or overlap them): links first (the URL is information), then bold, then
// italic. Returns { spans, protect, issues }.
function baleSpans(text, entities, fmt) {
  const issues = new Set();
  const protect = [];
  const candidates = [];
  for (const s of normalizeEntities(text, entities)) {
    if (AUTO_TYPES.has(s.type)) {
      protect.push(s);
      continue;
    }
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
  return { spans: chosen, protect, issues };
}

// text[a, b) as literal Bale text: escaped, except inside protected ranges.
function literal(text, a, b, protect, method) {
  let out = '';
  let pos = a;
  for (const p of protect) {
    if (p.end <= pos || p.start >= b) continue;
    const ps = Math.max(p.start, pos);
    out += escapeLiteral(text.slice(pos, ps), method);
    const pe = Math.min(p.end, b);
    out += text.slice(ps, pe);
    pos = pe;
  }
  return out + escapeLiteral(text.slice(pos, b), method);
}

function renderRange(text, sel, from, to, withFormat) {
  const { spans, protect } = sel;
  const method = current.escape;
  let out = '';
  let pos = from;
  if (withFormat) {
    for (const s0 of spans) {
      if (s0.end <= from || s0.start >= to) continue;
      const s = trimSpan(text, { ...s0, start: Math.max(s0.start, from), end: Math.min(s0.end, to) });
      if (!s) continue;
      out += literal(text, pos, s.start, protect, method);
      const inner = literal(text, s.start, s.end, protect, method);
      out += s.href ? `[${inner}](${s.href})` : s.marker + inner + s.marker;
      pos = s.end;
    }
  }
  return out + literal(text, pos, to, protect, method);
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
