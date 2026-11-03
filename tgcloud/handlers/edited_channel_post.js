// handlers/edited_channel_post.js — an edited post in a linked channel: the
// edit is queued behind earlier posts and applied to the Bale copy.

import { safeErrorText } from '../lib/bale.js';
import { getChannel } from '../lib/channels.js';
import { enqueueEdit, drain } from '../lib/mirror.js';

const SEND_WINDOW_MS = 8000;

export default async function (post) {
  const started = Date.now();
  if (!post || !post.chat || post.chat.type !== 'channel') return;
  const tgChannelId = post.chat.id;

  try {
    if (!(await getChannel(tgChannelId))) return;
    await enqueueEdit(tgChannelId, post);
    await drain(tgChannelId, { deadline: started + SEND_WINDOW_MS, probe: true });
  } catch (e) {
    console.error('edited_channel_post handler failed:', safeErrorText(e));
  }
}
