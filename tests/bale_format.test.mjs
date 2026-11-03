import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { toBaleMarkdown, baleChunks, setBaleFormat, baleFormat } from '../tgcloud/lib/format.js';
import { formatFromAnswers, answersFromFormat } from '../tgcloud/lib/bale_fmt.js';
import { captionParts, planMessage } from '../tgcloud/lib/forward.js';

beforeEach(() => setBaleFormat(null));

// The test post from Telegram, one format per line.
const LINES = ['test normal', 'test bold', 'test italic', 'test link', 'test underline', 'test strike', 'tsetmonospace', 'tset quote', '*test bold*', '_test italic_'];
function telegramPost() {
  const text = LINES.join('\n');
  const at = (i) => LINES.slice(0, i).join('\n').length + (i ? 1 : 0);
  const e = (type, i, extra) => ({ type, offset: at(i), length: LINES[i].length, ...extra });
  return {
    text,
    entities: [e('bold', 1), e('italic', 2), e('text_link', 3, { url: 'https://example.com/x' }), e('underline', 4),
      e('strikethrough', 5), e('code', 6), e('blockquote', 7)],
  };
}

test('the Telegram test post: bold, italic and link carry over; the rest is plain', () => {
  const { text, entities } = telegramPost();
  const r = baleChunks(text, entities, 4096);
  assert.equal(r.chunks[0].text, [
    'test normal', '*test bold*', '_test italic_', '[test link](https://example.com/x)', 'test underline', 'test strike',
    'tsetmonospace', 'tset quote', '*test bold*', '_test italic_',
  ].join('\n'));
  assert.deepEqual([...r.issues].sort(), ['blockquote', 'code', 'strikethrough', 'underline']);
});

test('markers the user typed are left as they are', () => {
  assert.equal(toBaleMarkdown('*x* and [a](b) _y_', []), '*x* and [a](b) _y_');
});

test('link inside Persian text, url parentheses encoded', () => {
  assert.equal(toBaleMarkdown('این لینک است', [{ type: 'text_link', offset: 4, length: 4, url: 'https://x.y/a(b)' }]), 'این [لینک](https://x.y/a%28b%29) است');
});

test('bold/italic only where the spacing rule holds', () => {
  assert.equal(toBaleMarkdown('سلام دنیا خوب', [{ type: 'bold', offset: 0, length: 4 }, { type: 'italic', offset: 5, length: 4 }]), '*سلام* _دنیا_ خوب');
  const r = baleChunks('abcd', [{ type: 'bold', offset: 1, length: 2 }], 4096);
  assert.equal(r.chunks[0].text, 'abcd');
  assert.ok(r.issues.has('bold'));
});

test('spaces at the edges of a bold range move outside the markers', () => {
  assert.equal(toBaleMarkdown('a bold b', [{ type: 'bold', offset: 1, length: 6 }]), 'a *bold* b');
});

test('nested or adjacent spans: the link wins, the rest is plain', () => {
  const r = baleChunks('click here now', [{ type: 'bold', offset: 0, length: 14 }, { type: 'text_link', offset: 6, length: 4, url: 'https://q.r' }], 4096);
  assert.equal(r.chunks[0].text, 'click [here](https://q.r) now');
  assert.ok(r.issues.has('bold'));
});

test('punctuation neighbours only when the diagnostic allowed them', () => {
  assert.equal(toBaleMarkdown('(bold)', [{ type: 'bold', offset: 1, length: 4 }]), '(bold)');
  setBaleFormat({ ...baleFormat(), punct: true });
  assert.equal(toBaleMarkdown('(bold)', [{ type: 'bold', offset: 1, length: 4 }]), '(*bold*)');
});

test('diagnostic answers: double markers, italic off', () => {
  setBaleFormat(formatFromAnswers(['b2', 'link']));
  assert.equal(toBaleMarkdown('a b c', [{ type: 'bold', offset: 2, length: 1 }, { type: 'italic', offset: 4, length: 1 }]), 'a **b** c');
});

test('the diagnostic starts from the format in use (saving unchanged keeps it)', () => {
  const now = baleFormat();
  const back = formatFromAnswers(answersFromFormat(now));
  for (const k of ['bold', 'italic', 'link', 'punct', 'glued', 'zwnj', 'caption']) assert.equal(back[k], now[k], k);
});

test('UTF-16 offsets with emoji', () => {
  assert.equal(toBaleMarkdown('😀 go', [{ type: 'text_link', offset: 3, length: 2, url: 'https://e.f' }]), '😀 [go](https://e.f)');
});

test('plain fallback drops formatting', () => {
  const r = baleChunks('a link', [{ type: 'text_link', offset: 2, length: 4, url: 'https://e.f' }], 4096);
  assert.equal(r.chunks[0].plain, 'a link');
});

test('chunks are measured as sent (markup included) and never split a link', () => {
  const text = ('word ').repeat(50);
  const ents = [];
  for (let i = 0; i < 50; i++) ents.push({ type: 'text_link', offset: i * 5, length: 4, url: 'https://example.com/' + i });
  const r = baleChunks(text, ents, 300);
  assert.ok(r.chunks.length > 1);
  for (const c of r.chunks) {
    assert.ok(c.text.length <= 300);
    assert.equal((c.text.match(/\[/g) || []).length, (c.text.match(/\]\(/g) || []).length);
  }
});

test('captions use caption_entities; formatting off in captions when the diagnostic said so', () => {
  const m = { caption: 'see link and bold', caption_entities: [{ type: 'text_link', offset: 4, length: 4, url: 'https://c.d' }, { type: 'bold', offset: 13, length: 4 }] };
  assert.equal(captionParts(m).caption, 'see [link](https://c.d) and *bold*');
  setBaleFormat({ ...baleFormat(), caption: false });
  assert.equal(captionParts(m).caption, 'see link and bold');
});

test('a long caption goes out as text chunks built from the raw caption', () => {
  const m = { message_id: 3, photo: [{ file_id: 'p', file_unique_id: 'u' }], caption: 'bold ' + 'x'.repeat(1100), caption_entities: [{ type: 'bold', offset: 0, length: 4 }] };
  const plan = planMessage(m);
  assert.equal(plan.ops[0].op, 'media');
  assert.equal(plan.ops[0].caption, '');
  assert.ok(plan.ops[1].text.startsWith('*bold* x'));
});

test('a text message with a hyperlink is planned with the link', () => {
  const plan = planMessage({ message_id: 1, text: 'go here', entities: [{ type: 'text_link', offset: 3, length: 4, url: 'https://h.i' }] });
  assert.equal(plan.ops[0].text, 'go [here](https://h.i)');
  assert.equal(plan.ops[0].plain, 'go here');
});

test('touching bold pieces become one bold run in Bale too', () => {
  assert.equal(toBaleMarkdown('#tag rest', [{ type: 'hashtag', offset: 0, length: 4 }, { type: 'bold', offset: 0, length: 4 }, { type: 'bold', offset: 4, length: 5 }]), '*#tag rest*');
});
