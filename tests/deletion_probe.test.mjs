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

// The check itself, with Telegram's answers as measured live.
const { api } = await import('sdk');
const { channelPostGone } = await import('../tgcloud/lib/post_check.js');
const refuse = (description) => async () => { throw Object.assign(new Error(description), { code: 400, description }); };
const calls = [];
const setup = (answers) => {
  calls.length = 0;
  for (const [method, fn] of Object.entries(answers)) api[method] = async (p) => { calls.push(method); return fn(p); };
};

test('a post deleted minutes ago counts as deleted though the edit check still says it exists', async () => {
  setup({
    editMessageReplyMarkup: refuse("Bad Request: message can't be edited"),
    setMessageReaction: refuse('Bad Request: MESSAGE_ID_INVALID'),
    forwardMessage: refuse('Bad Request: MESSAGE_ID_INVALID'),
    deleteMessage: async () => true,
  });
  assert.equal(await channelPostGone(-100, 5, 7), true);
  assert.deepEqual(calls, ['setMessageReaction', 'forwardMessage']);
});

test('an existing post is kept; nothing is forwarded', async () => {
  setup({ setMessageReaction: async () => true, forwardMessage: async () => ({ message_id: 1 }) });
  assert.equal(await channelPostGone(-100, 5, 7), false);
  assert.deepEqual(calls, ['setMessageReaction']);
});

test('if the forward arrives, the post exists and the forward is removed', async () => {
  setup({
    setMessageReaction: refuse('Bad Request: MESSAGE_ID_INVALID'),
    forwardMessage: async () => ({ message_id: 99 }),
    deleteMessage: async () => true,
  });
  assert.equal(await channelPostGone(-100, 5, 7), false);
  assert.deepEqual(calls, ['setMessageReaction', 'forwardMessage', 'deleteMessage']);
});

test('reactions switched off: the edit check decides', async () => {
  setup({
    setMessageReaction: refuse('Bad Request: REACTION_INVALID'),
    editMessageReplyMarkup: refuse('Bad Request: message to edit not found'),
  });
  assert.equal(await channelPostGone(-100, 5, 7), true);
  setup({
    setMessageReaction: refuse('Bad Request: REACTION_INVALID'),
    editMessageReplyMarkup: refuse("Bad Request: message can't be edited"),
  });
  assert.equal(await channelPostGone(-100, 5, 7), false);
});
