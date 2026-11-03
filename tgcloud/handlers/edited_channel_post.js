// handlers/edited_channel_post.js — an edited post in a linked channel. For
// Bale the edit is queued behind earlier posts and applied to the Bale copy;
// for Eitaa the owner is told what to edit (EitaaYar has no edit method).

import { safeErrorText } from '../lib/bale.js';
import { getChannel } from '../lib/channels.js';
import { enqueueEdit, drain } from '../lib/mirror.js';
import { mirrorEdit } from '../lib/eitaa_mirror.js';

const SEND_WINDOW_MS = 8000;

async function editInBale(post, started) {
  const tgChannelId = post.chat.id;
  try {
    if (!(await getChannel(tgChannelId))) return;
    await enqueueEdit(tgChannelId, post);
    await drain(tgChannelId, { deadline: started + SEND_WINDOW_MS, probe: true });
  } catch (e) {
    console.error('edited_channel_post handler failed:', safeErrorText(e));
  }
}

async function editInEitaa(post) {
  try {
    await mirrorEdit(post);
  } catch (e) {
    console.error('eitaa edit failed:', e && e.name);
  }
}

export default async function (post) {
  const started = Date.now();
  if (!post || !post.chat || post.chat.type !== 'channel') return;
  await Promise.all([editInBale(post, started), editInEitaa(post)]);
}
