// handlers/channel_post.js — posts in Telegram channels where the bot is
// admin. A channel can be mirrored to Bale (lib/mirror.js: a queue that
// keeps posts until Bale accepts them) and/or to Eitaa (lib/eitaa_mirror.js);
// both run side by side within one run's time.

import { api } from 'sdk';
import { safeErrorText } from '../lib/bale.js';
import { loadBaleFormat } from '../lib/bale_fmt.js';
import { isAlbumItem, collectAlbum } from '../lib/album.js';
import { getChannel, telegramChannelTitle } from '../lib/channels.js';
import { alreadyQueued, enqueuePost, enqueueAlbum, drain } from '../lib/mirror.js';
import { mirrorChannelPost } from '../lib/eitaa_mirror.js';
import { maybeCleanup } from '../lib/store.js';
import { T } from '../lib/texts.js';

// No new send starts after this much of the run (a run is cut off near 30 s).
const SEND_WINDOW_MS = 8000;
const EITAA_WINDOW_MS = 10000;

async function mirrorToBale(post, started) {
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

async function mirrorToEitaa(post, started) {
  try {
    await mirrorChannelPost(post, { deadline: started + EITAA_WINDOW_MS });
  } catch (e) {
    console.error('eitaa channel_post failed:', e && e.name);
  }
}

export default async function (post) {
  const started = Date.now();
  if (!post || !post.chat || post.chat.type !== 'channel') return;
  await loadBaleFormat();
  await Promise.all([mirrorToBale(post, started), mirrorToEitaa(post, started)]);
}
