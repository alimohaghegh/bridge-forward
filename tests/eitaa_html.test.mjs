import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toEitaaChunks, toEitaaCaption } from '../tgcloud/lib/eitaa_html.js';

const opts = { tags: ['b', 'i', 'code', 'a'], escapesOk: true, countMarkup: true, limit: 4096 };
const one = (text, entities, o) => toEitaaChunks(text, entities, { ...opts, ...o });

test('plain text goes out unescaped and without parse_mode', () => {
  const r = one('a < b & c', []);
  assert.deepEqual(r.chunks, [{ text: 'a < b & c', html: false }]);
});

test('hyperlink becomes <a href>, with & and quotes escaped', () => {
  const r = one('read this now', [{ type: 'text_link', offset: 5, length: 4, url: 'https://a.b/?x="1"&y=2' }]);
  assert.equal(r.chunks[0].text, 'read <a href="https://a.b/?x=&quot;1&quot;&amp;y=2">this</a> now');
  assert.equal(r.chunks[0].html, true);
});

test('caption entities work the same way', () => {
  const r = toEitaaCaption('photo link', [{ type: 'text_link', offset: 6, length: 4, url: 'https://x.y' }], { ...opts, limit: 1024 });
  assert.equal(r.caption.text, 'photo <a href="https://x.y">link</a>');
  assert.equal(r.fits, true);
});

test('bold, italic, code; text is escaped', () => {
  const r = one('a<b c d', [{ type: 'bold', offset: 0, length: 3 }, { type: 'italic', offset: 4, length: 1 }, { type: 'code', offset: 6, length: 1 }]);
  assert.equal(r.chunks[0].text, '<b>a&lt;b</b> <i>c</i> <code>d</code>');
});

test('nested and overlapping entities produce well-nested tags', () => {
  assert.equal(one('ab cd', [{ type: 'bold', offset: 0, length: 5 }, { type: 'italic', offset: 3, length: 2 }]).chunks[0].text, '<b>ab <i>cd</i></b>');
  assert.equal(one('abcdefgh', [{ type: 'bold', offset: 0, length: 5 }, { type: 'italic', offset: 3, length: 5 }]).chunks[0].text, '<b>abc<i>de</i></b><i>fgh</i>');
});

test('UTF-16 offsets: an emoji counts as two units', () => {
  assert.equal(one('😀 hi', [{ type: 'bold', offset: 3, length: 2 }]).chunks[0].text, '😀 <b>hi</b>');
});

test('unsupported tags are never emitted; losses are recorded', () => {
  const r = one('u s p q', [
    { type: 'underline', offset: 0, length: 1 }, { type: 'strikethrough', offset: 2, length: 1 },
    { type: 'spoiler', offset: 4, length: 1 }, { type: 'blockquote', offset: 6, length: 1 },
  ]);
  assert.equal(r.chunks[0].text, 'u s p q');
  assert.deepEqual([...r.issues].sort(), ['blockquote', 'spoiler', 'strikethrough', 'underline']);
});

test('the Telegram test post renders like Telegram where Eitaa can', () => {
  const lines = ['test normal', 'test bold', 'test italic', 'test link', 'test underline', 'test strike', 'tsetmonospace', 'tset quote'];
  const at = (i) => lines.slice(0, i).join('\n').length + (i ? 1 : 0);
  const e = (type, i, extra) => ({ type, offset: at(i), length: lines[i].length, ...extra });
  const r = one(lines.join('\n'), [e('bold', 1), e('italic', 2), e('text_link', 3, { url: 'https://example.com/x' }), e('underline', 4), e('strikethrough', 5), e('code', 6), e('blockquote', 7)]);
  assert.equal(r.chunks[0].html, true);
  assert.equal(r.chunks[0].text, 'test normal\n<b>test bold</b>\n<i>test italic</i>\n<a href="https://example.com/x">test link</a>\ntest underline\ntest strike\n<code>tsetmonospace</code>\ntset quote');
});

test('pre becomes one <code> per line', () => {
  const r = one('l1\nl2\n\nl3', [{ type: 'pre', offset: 0, length: 9, language: 'js' }]);
  assert.equal(r.chunks[0].text, '<code>l1</code>\n<code>l2</code>\n\n<code>l3</code>');
});

test('auto-detected urls and mentions stay plain without an issue', () => {
  const r = one('@me https://x.y', [{ type: 'mention', offset: 0, length: 3 }, { type: 'url', offset: 4, length: 11 }]);
  assert.equal(r.chunks[0].html, false);
  assert.equal(r.issues.size, 0);
});

test('long text splits at paragraphs without breaking tags or losing text', () => {
  const text = Array.from({ length: 30 }, (_, i) => `پاراگراف ${i} ` + 'متن '.repeat(40)).join('\n\n');
  const r = one(text, [{ type: 'bold', offset: 100, length: 3000 }], { limit: 1000 });
  assert.ok(r.chunks.length > 1);
  for (const c of r.chunks) {
    assert.ok(c.text.length <= 1000);
    assert.equal((c.text.match(/<b>/g) || []).length, (c.text.match(/<\/b>/g) || []).length);
  }
  assert.equal(r.chunks.map((c) => c.text.replace(/<\/?b>/g, '')).join('').replace(/\s/g, ''), text.replace(/\s/g, ''));
});
