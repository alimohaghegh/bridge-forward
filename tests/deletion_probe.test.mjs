import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deletedPostAnswer } from '../tgcloud/lib/util.js';

const err = (description) => ({ code: 400, description });

test('both Telegram answers for a deleted post count as deleted (seen live)', () => {
  assert.equal(deletedPostAnswer(err('Bad Request: message to edit not found')), true);
  assert.equal(deletedPostAnswer(err('Bad Request: MESSAGE_ID_INVALID')), true);
});

test('answers for an existing post do not', () => {
  assert.equal(deletedPostAnswer(err("Bad Request: message can't be edited")), false);
  assert.equal(deletedPostAnswer(err('Bad Request: message is not modified: specified new message content and reply markup are exactly the same')), false);
  assert.equal(deletedPostAnswer({ code: 403, description: 'Forbidden: bot is not a member of the channel chat' }), false);
  assert.equal(deletedPostAnswer({ code: 429, description: 'Too Many Requests' }), false);
  assert.equal(deletedPostAnswer(null), false);
});
