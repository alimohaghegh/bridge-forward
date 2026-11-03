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
  // Invisible marks (U+2060/U+200B) may be added to repeated pieces.
  assert.equal(r.chunks.map((c) => c.text.replace(/<\/?b>/g, '')).join('').replace(/[\s\u2060\u200B]/g, ''), text.replace(/\s/g, ''));
});

// EitaaYar places tags by searching for their text from the message start.
const MARKS = /[⁠​]/g;
test('a tagged word that also appears earlier is made unique (invisibly)', () => {
  const r = one('test test', [{ type: 'bold', offset: 5, length: 4 }]);
  const html = r.chunks[0].text;
  assert.match(html, /^test <b>test[⁠​]+<\/b>$/);
  const inner = html.match(/<b>(.*)<\/b>/)[1];
  assert.equal(html.replace(/<[^>]+>/g, '').indexOf(inner), 5);
});

test('words that appear once are left untouched', () => {
  assert.equal(one('a bold b', [{ type: 'bold', offset: 2, length: 4 }]).chunks[0].text, 'a <b>bold</b> b');
});

test('the Telegram test post with the same word everywhere: every tag finds its own place', () => {
  const lines = ['*test*', '_test_', '/test/', 'test', 'test', 'test', 'test', 'test', 'test', 'test', 'test'];
  const at = (i) => lines.slice(0, i).join('\n').length + (i ? 1 : 0);
  const e = (type, i, extra) => ({ type, offset: at(i), length: 4, ...extra });
  const ents = [e('text_link', 3, { url: 'https://example.com/' }), e('bold', 5), e('italic', 6), e('underline', 7), e('strikethrough', 8), e('code', 9), e('blockquote', 10)];
  const html = one(lines.join('\n'), ents).chunks[0].text;
  const plain = html.replace(/<[^>]+>/g, '');
  const codes = new Set();
  for (const [, inner] of html.matchAll(/<(?:a [^>]*|b|i|code)>([^<]*)<\//g)) {
    assert.equal(plain.indexOf(inner), plain.lastIndexOf(inner), 'each tagged text occurs once');
    codes.add(inner);
  }
  assert.equal(codes.size, 4);
  assert.equal(plain.replace(MARKS, ''), lines.join('\n'));
});

test('codes never contain each other, even with many duplicates', () => {
  const text = Array(20).fill('w').join(' ');
  const ents = Array.from({ length: 20 }, (_, i) => ({ type: 'bold', offset: i * 2, length: 1 }));
  const html = one(text, ents).chunks[0].text;
  const plain = html.replace(/<[^>]+>/g, '');
  const inners = [...html.matchAll(/<b>([^<]*)<\/b>/g)].map((m) => m[1]);
  assert.equal(new Set(inners).size, 20);
  for (const x of inners) assert.equal(plain.indexOf(x), plain.lastIndexOf(x));
});

test('touching pieces of the same format are joined (no "</b><b>")', () => {
  const r = one('#tag rest', [{ type: 'hashtag', offset: 0, length: 4 }, { type: 'bold', offset: 0, length: 4 }, { type: 'bold', offset: 4, length: 5 }]);
  assert.equal(r.chunks[0].text, '<b>#tag rest</b>');
});

test('a format spanning a line break is closed and reopened per line', () => {
  const r = one('line one\nline two', [{ type: 'italic', offset: 0, length: 17 }]);
  assert.equal(r.chunks[0].text, '<i>line one</i>\n<i>line two</i>');
});

test('the real post: bold over a hashtag, italic poem over two lines', () => {
  const text = '#گزارش_تصویری | شب نخست\n\nز عزم توست ولایت\nز صبر توست رسالت\n\nپایان';
  const r = one(text, [
    { type: 'hashtag', offset: 0, length: 13 }, { type: 'bold', offset: 0, length: 13 }, { type: 'bold', offset: 13, length: 10 },
    { type: 'italic', offset: 25, length: 33 },
  ]);
  const html = r.chunks[0].text;
  assert.ok(!html.includes('</b><b>'));
  for (const [, inner] of html.matchAll(/<(b|i)>([^<]*)<\/\1>/g)) assert.ok(!inner.includes('\n'), 'no tag spans a line break');
  assert.equal(html, '<b>#گزارش_تصویری | شب نخست</b>\n\n<i>ز عزم توست ولایت</i>\n<i>ز صبر توست رسالت</i>\n\nپایان');
});
