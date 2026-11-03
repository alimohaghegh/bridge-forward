import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildParts } from '../tgcloud/lib/eitaa_mirror.js';
import { eitaaCaps } from '../tgcloud/lib/eitaa.js';

const caps = { tags: ['b', 'i', 'code', 'a'], escapesOk: true, textLimit: 4096, captionLimit: 1024, limitCountsMarkup: true };

test('forwarded posts go out like the channel\'s own (no "forwarded from" line)', () => {
  const r = buildParts({ message_id: 5, text: 'hi', forward_origin: { type: 'channel', chat: { title: 'X' } } }, caps, { link: 'L' });
  assert.deepEqual(r.parts.map((p) => p.text), ['hi']);
});

test('photo caption with a hyperlink', () => {
  const r = buildParts({ message_id: 7, photo: [{ file_id: 'p', file_size: 10 }], caption: 'see link', caption_entities: [{ type: 'text_link', offset: 4, length: 4, url: 'https://x.y' }] }, caps, { link: 'L' });
  assert.equal(r.parts[0].type, 'file');
  assert.equal(r.parts[0].caption.text, 'see <a href="https://x.y">link</a>');
  assert.equal(r.parts[0].caption.html, true);
});

test('file over 20 MB: caption plus link for public channels', () => {
  const r = buildParts({ message_id: 6, document: { file_id: 'f', file_size: 30 * 1024 * 1024 }, caption: 'c' }, caps, { link: 'https://t.me/x/6', public: true });
  assert.ok(r.issues.has('too_large'));
  assert.equal(r.parts.length, 1);
  assert.ok(r.parts[0].text.includes('https://t.me/x/6'));
});

test('stored answers can no longer switch Eitaa formatting off', async () => {
  const live = await eitaaCaps();
  assert.deepEqual(live.tags, ['b', 'i', 'code', 'a']);
  assert.equal(live.escapesOk, true);
  const r = buildParts({ message_id: 9, text: 'bold', entities: [{ type: 'bold', offset: 0, length: 4 }] }, live, { link: 'L' });
  assert.equal(r.parts[0].text, '<b>bold</b>');
});

test('dice and similar posts produce nothing (owner is told)', () => {
  const r = buildParts({ message_id: 8, dice: { emoji: '🎲', value: 3 } }, caps, { link: 'L' });
  assert.equal(r.parts.length, 0);
  assert.ok(r.issues.has('unsupported'));
});
