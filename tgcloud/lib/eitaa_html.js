// Telegram text + entities → HTML for EitaaYar (parse_mode=html).
//
// Verified live in Eitaa: <b>/<strong>, <i>/<em>, <code> and <a href> render,
// and &amp; &lt; &gt; are decoded. <u>, <s>, <strike>, <del>, <pre>,
// <blockquote>, <tg-spoiler> and <span> show up as literal text, so they are
// never emitted: pre becomes one <code> per line, and underline,
// strikethrough, spoiler, blockquote, custom emoji… become plain text and are
// reported as issues. EitaaYar doesn't parse a tag that contains a line
// break (it prints it as text), so every tag is closed and reopened at each
// line break — it looks the same.
//
// EitaaYar places each tag by searching for the tagged text from the start
// of the message (seen live: in "test … <b>test</b>" the bold lands on the
// first "test"). So when a tagged piece of text also occurs elsewhere in the
// message, invisible word joiners (U+2060) are put after its first
// character — a different number for each such piece — to make it unique.

import { AUTO_TYPES, normalizeEntities, renderNested, chunkRanges } from './entities.js';

// The only tags ever emitted (the stored /eitaa_diag fmt answer may narrow
// this set, never widen it).
const EMITTABLE = new Set(['b', 'strong', 'i', 'em', 'code', 'a']);

const TAG_OPTIONS = {
  bold: ['b', 'strong'],
  italic: ['i', 'em'],
  code: ['code'],
  pre: ['code'],
  text_link: ['a'],
};

export function escapeText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s) {
  return escapeText(s).replace(/"/g, '&quot;');
}

function safeUrl(url) {
  return typeof url === 'string' && /^https?:\/\/\S+$/i.test(url) ? url : null;
}

// Adds span `s` cut into one piece per line (pre becomes one <code> per
// line this way too); pieces that are only spaces are dropped.
function pushPerLine(text, spans, s) {
  let a = s.start;
  for (let i = s.start; i <= s.end; i++) {
    if (i === s.end || text[i] === '\n') {
      if (i > a && text.slice(a, i).trim()) spans.push({ ...s, start: a, end: i });
      a = i + 1;
    }
  }
}

// Spans with their open/close tags, plus the entity types that were lost.
function htmlSpans(text, entities, tags) {
  const allowed = new Set((tags || []).filter((t) => EMITTABLE.has(t)));
  const spans = [];
  const issues = new Set();
  for (const s of normalizeEntities(text, entities)) {
    if (AUTO_TYPES.has(s.type)) continue;
    const tag = (TAG_OPTIONS[s.type] || []).find((t) => allowed.has(t));
    if (!tag) {
      issues.add(s.type);
      continue;
    }
    if (tag === 'a') {
      const url = safeUrl(s.url);
      if (!url) {
        issues.add('text_link');
        continue;
      }
      pushPerLine(text, spans, { ...s, open: `<a href="${escapeAttr(url)}">`, close: '</a>' });
      continue;
    }
    pushPerLine(text, spans, { ...s, open: `<${tag}>`, close: `</${tag}>` });
  }
  spans.sort((a, b) => a.start - b.start || b.end - a.end || a.index - b.index);
  return { spans, issues };
}

// Invisible marks: a code of equal length per duplicated piece, so no code
// can be found inside another.
const MARKS = ['\u2060', '\u200B'];

// { absolute end position of a span: invisible code } for every tagged
// piece whose text also appears anywhere else in the whole text.
function uniqueMarks(text, spans) {
  const dup = spans.filter((s) => {
    const inner = text.slice(s.start, s.end);
    return text.indexOf(inner) !== s.start || text.indexOf(inner, s.start + 1) !== -1;
  });
  const plan = new Map();
  if (!dup.length) return plan;
  const width = Math.max(1, Math.ceil(Math.log2(dup.length + 1)));
  dup.forEach((s, i) => {
    let code = '';
    for (let b = width - 1; b >= 0; b--) code += MARKS[((i + 1) >> b) & 1];
    plan.set(s.end, (plan.get(s.end) || '') + code);
  });
  return plan;
}

function hooksFor(plan) {
  return {
    open: (s) => s.open,
    close: (s) => s.close,
    // Every span end is a cut, so its code goes right before the closing tag.
    text: (t, from) => escapeText(t) + (plan.get(from + t.length) || ''),
  };
}

// Converts a text (or caption) into chunks that each fit `limit`.
// opts: { tags, limit, countMarkup (limit applies to the HTML source),
//         escapesOk (Eitaa decodes &amp; &lt; &gt;) }
// Returns { chunks: [{ text, html }], issues: Set<entity type> }: `html`
// says whether a chunk needs parse_mode=html. Text without any formatting
// goes out plain (nothing to escape, nothing to break).
export function toEitaaChunks(text, entities, opts) {
  text = String(text || '');
  const { spans, issues } = htmlSpans(text, entities, opts.tags);
  let useHtml = spans.length > 0;
  if (useHtml && opts.escapesOk === false && /[&<>]/.test(text)) {
    // Eitaa would show "&amp;" literally: keep the characters, lose the format.
    useHtml = false;
    issues.add('format');
  }
  const hooks = hooksFor(uniqueMarks(text, spans));
  const render = (from, to) => {
    const plain = text.slice(from, to);
    const out = useHtml ? renderNested(text, spans, from, to, hooks) : plain;
    return { text: out, size: opts.countMarkup === false ? plain.length : out.length };
  };
  const chunks = chunkRanges(text, opts.limit, render).map((c) => ({ text: c.text, html: useHtml }));
  return { chunks, issues };
}

// A caption as one piece: { caption: { text, html }, fits, issues }.
export function toEitaaCaption(text, entities, opts) {
  const { chunks, issues } = toEitaaChunks(text, entities, { ...opts, limit: Number.MAX_SAFE_INTEGER });
  const one = chunks[0] || { text: '', html: false };
  const size = opts.countMarkup === false ? String(text || '').length : one.text.length;
  return { caption: one, fits: size <= opts.limit, issues };
}
