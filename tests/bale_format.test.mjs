import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { toBaleMarkdown, baleChunks, setBaleFormat } from '../tgcloud/lib/format.js';
import { formatFromAnswers } from '../tgcloud/lib/bale_fmt.js';
import { captionParts, planMessage } from '../tgcloud/lib/forward.js';

const ZW = '​';
const answered = { answered: true, bold: '*', italic: '_', link: true, punct: false, glued: false, zwnj: false, escape: 'zwsp', caption: true };

beforeEach(() => setBaleFormat(null));

test('default (before /bale_diag fmt): links only', () => {
  const ents = [{ type: 'bold', offset: 0, length: 4 }, { type: 'text_link', offset: 5, length: 4, url: 'https://a.b/c' }];
  assert.equal(toBaleMarkdown('bold link', ents), 'bold [link](https://a.b/c)');
});

test('link inside Persian text, url parentheses encoded', () => {
  assert.equal(toBaleMarkdown('این لینک است', [{ type: 'text_link', offset: 4, length: 4, url: 'https://x.y/a(b)' }]), 'این [لینک](https://x.y/a%28b%29) است');
});

test('literal markers typed by the user stay literal (ZWSP by default)', () => {
  assert.equal(toBaleMarkdown('*x* and [a](b) `c` _d_', []), `*${ZW}x*${ZW} and [${ZW}a]${ZW}(b) \`${ZW}c\`${ZW} _${ZW}d_${ZW}`);
});

test('backslash escaping when the diagnostic chose it', () => {
  setBaleFormat({ ...answered, escape: 'backslash' });
  assert.equal(toBaleMarkdown('*x*', []), '\\*x\\*');
});

test('auto-detected urls are not escaped (stay clickable)', () => {
  assert.equal(toBaleMarkdown('see https://a.b/x_y_z', [{ type: 'url', offset: 4, length: 17 }]), 'see https://a.b/x_y_z');
});

test('bold/italic after the answers, only where the spacing rule holds', () => {
  setBaleFormat(answered);
  assert.equal(toBaleMarkdown('سلام دنیا خوب', [{ type: 'bold', offset: 0, length: 4 }, { type: 'italic', offset: 5, length: 4 }]), '*سلام* _دنیا_ خوب');
  // Glued to letters: plain, recorded as a loss.
  const r = baleChunks('abcd', [{ type: 'bold', offset: 1, length: 2 }], 4096);
  assert.equal(r.chunks[0].text, 'abcd');
  assert.ok(r.issues.has('bold'));
});

test('spaces at the edges of a bold range move outside the markers', () => {
  setBaleFormat(answered);
  assert.equal(toBaleMarkdown('a bold b', [{ type: 'bold', offset: 1, length: 6 }]), 'a *bold* b');
});

test('nested or adjacent spans: the link wins, the rest is plain', () => {
  setBaleFormat(answered);
  const r = baleChunks('click here now', [{ type: 'bold', offset: 0, length: 14 }, { type: 'text_link', offset: 6, length: 4, url: 'https://q.r' }], 4096);
  assert.equal(r.chunks[0].text, 'click [here](https://q.r) now');
  assert.ok(r.issues.has('bold'));
});

test('punctuation neighbours only when the diagnostic allowed them', () => {
  setBaleFormat(answered);
  assert.equal(toBaleMarkdown('(bold)', [{ type: 'bold', offset: 1, length: 4 }]), `(bold)`);
  setBaleFormat({ ...answered, punct: true });
  assert.equal(toBaleMarkdown('(bold)', [{ type: 'bold', offset: 1, length: 4 }]), '(*bold*)');
});

test('double markers when only ** works', () => {
  setBaleFormat(formatFromAnswers(['b2', 'link']));
  assert.equal(toBaleMarkdown('a b c', [{ type: 'bold', offset: 2, length: 1 }]), 'a **b** c');
});

test('UTF-16 offsets with emoji', () => {
  assert.equal(toBaleMarkdown('😀 go', [{ type: 'text_link', offset: 3, length: 2, url: 'https://e.f' }]), '😀 [go](https://e.f)');
});

test('plain fallback keeps escaping but drops formatting', () => {
  const r = baleChunks('*x* link', [{ type: 'text_link', offset: 4, length: 4, url: 'https://e.f' }], 4096);
  assert.equal(r.chunks[0].plain, `*${ZW}x*${ZW} link`);
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
  const m = { caption: 'see link', caption_entities: [{ type: 'text_link', offset: 4, length: 4, url: 'https://c.d' }] };
  assert.equal(captionParts(m).caption, 'see [link](https://c.d)');
  setBaleFormat({ ...answered, caption: false });
  assert.equal(captionParts(m).caption, 'see link');
});

test('a long caption goes out as text chunks built from the raw caption', () => {
  const m = { message_id: 3, photo: [{ file_id: 'p', file_unique_id: 'u' }], caption: '*'.repeat(10) + 'x'.repeat(1100) };
  const plan = planMessage(m);
  assert.equal(plan.ops[0].op, 'media');
  assert.equal(plan.ops[0].caption, '');
  assert.ok(plan.ops[1].text.startsWith(`*${ZW}*${ZW}`));
});

test('a text message with a hyperlink is planned with the link', () => {
  const plan = planMessage({ message_id: 1, text: 'go here', entities: [{ type: 'text_link', offset: 3, length: 4, url: 'https://h.i' }] });
  assert.equal(plan.ops[0].text, 'go [here](https://h.i)');
  assert.equal(plan.ops[0].plain, 'go here');
});
