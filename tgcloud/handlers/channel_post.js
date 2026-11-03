// handlers/channel_post.js — posts in Telegram channels where the bot is
// admin. Posts of linked channels go into the mirror queue (lib/mirror.js),
// which sends them to Bale in order and keeps them until Bale accepts them.

import { api } from 'sdk';
import { safeErrorText } from '../lib/bale.js';
import { isAlbumItem, collectAlbum } from '../lib/album.js';
import { getChannel, telegramChannelTitle } from '../lib/channels.js';
import { alreadyQueued, enqueuePost, enqueueAlbum, drain } from '../lib/mirror.js';
import { maybeCleanup } from '../lib/store.js';
import { T } from '../lib/texts.js';

// No new send starts after this much of the run (a run is cut off near 30 s).
const SEND_WINDOW_MS = 8000;

export default async function (post) {
  const started = Date.now();
  if (!post || !post.chat || post.chat.type !== 'channel') return;
  const tgChannelId = post.chat.id;

  try {
    const link = await getChannel(tgChannelId);
    if (!link) return;

    if (!(await alreadyQueued(tgChannelId, post.message_id))) {
      if (isAlbumItem(post)) {
        const items = await collectAlbum(post);
        if (items) await enqueueAlbum(tgChannelId, items);
        else return; // the album's first item sends it
      } else if (!(await enqueuePost(tgChannelId, post))) {
        const title = await telegramChannelTitle(tgChannelId);
        await api.sendMessage({ chat_id: link.ownerTgId, text: T.chUnsupported(title) }).catch(() => null);
      }
    }
    await maybeCleanup();
    await drain(tgChannelId, { deadline: started + SEND_WINDOW_MS, probe: true });
  } catch (e) {
    console.error('channel_post handler failed:', safeErrorText(e));
  }
}
