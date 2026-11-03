// handlers/channel_post.js — posts in Telegram channels where the bot is
// admin. Posts of channels linked with /channel are re-published in the
// linked Bale channel; failures are reported to whoever set up the link.
// Post contents are never stored (album items only for seconds) or logged.

import { api } from 'sdk';
import { isSystemError, safeErrorText } from '../lib/bale.js';
import { isSupported } from '../lib/forward.js';
import { deliverMessage } from '../lib/album.js';
import { getChannel, countChannelDelivery } from '../lib/channels.js';
import { claimMessage, maybeCleanup, recordBaleSuccess, recordBaleFailure } from '../lib/store.js';
import { T } from '../lib/texts.js';

export default async function (post) {
  if (!post || !post.chat || post.chat.type !== 'channel') return;
  const tgChannelId = post.chat.id;

  try {
    const link = await getChannel(tgChannelId);
    if (!link) return;
    if (!(await claimMessage(tgChannelId, post.message_id))) return; // redelivery
    await maybeCleanup();
    if (!isSupported(post)) return; // stickers, polls…: nothing to publish

    const result = await deliverMessage(link.baleChatId, post);
    if (!result) return; // another run sends this album
    await countChannelDelivery(tgChannelId, result.ok);

    if (result.ok) {
      await recordBaleSuccess();
      return;
    }
    if (isSystemError(result.reason)) await recordBaleFailure('channel/' + result.reason);
    const reason = T.chFailReasons[result.reason] || T.fail[result.reason] || T.fail.rejected;
    await api.sendMessage({ chat_id: link.ownerTgId, text: T.chFail(post.chat.title || '', reason) })
      .catch(() => null);
  } catch (e) {
    console.error('channel_post handler failed:', safeErrorText(e));
  }
}
