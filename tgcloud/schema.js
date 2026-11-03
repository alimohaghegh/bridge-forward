import { table, integer, text, boolean, index, uniqueIndex, sql } from 'sdk/db';

// Privacy: only ids, link state, timestamps and counters are stored — never
// message contents, names or usernames (album items, below, are held for
// seconds only). All timestamps are unix seconds.

// One row per Telegram user who has talked to the bot.
export const users = table('users', {
  tgId:           integer('tg_id').primaryKey(),
  baleChatId:     integer('bale_chat_id'),            // null = not linked
  linkedAt:       integer('linked_at'),
  blocked:        boolean('blocked').notNull().default(false),
  deliveredCount: integer('delivered_count').notNull().default(0),
  failedCount:    integer('failed_count').notNull().default(0),
  createdAt:      integer('created_at').notNull().default(sql`(unixepoch())`),
  lastSeenAt:     integer('last_seen_at').notNull().default(sql`(unixepoch())`),
  // Multi-step /channel setup: which answer the bot is waiting for
  // ('tg_channel' | 'bale_channel'), the Telegram channel chosen in step 1,
  // and when the wait expires.
  pendingStep:      text('pending_step'),
  pendingTgChannel: integer('pending_tg_channel'),
  pendingUntil:     integer('pending_until'),
}, (t) => ({
  baleIdx:     index('idx_users_bale_chat').on(t.baleChatId),
  lastSeenIdx: index('idx_users_last_seen').on(t.lastSeenAt),
}));

// Single-use linking codes. A code is consumed by setting used_at.
// (Named `codes`: an older, incompatible `link_codes` table exists in the DB.)
export const linkCodes = table('codes', {
  code:      text('code').primaryKey(),
  tgId:      integer('tg_id').notNull(),
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
  expiresAt: integer('expires_at').notNull(),
  usedAt:    integer('used_at'),
  // Set for codes that link a Bale channel/group to this Telegram channel.
  tgChannelId: integer('tg_channel_id'),
}, (t) => ({
  tgIdx:      index('idx_codes_tg').on(t.tgId),
  expiresIdx: index('idx_codes_expires').on(t.expiresAt),
}));

// A single row (id = 1): Bale getUpdates offset, a short poll lock, and the
// failure counter used for rate-limited owner alerts.
export const baleState = table('bale_state', {
  id:                  integer('id').primaryKey(),
  updateOffset:        integer('update_offset').notNull().default(0),
  lockUntil:           integer('lock_until').notNull().default(0),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  lastAlertAt:         integer('last_alert_at').notNull().default(0),
});

// Redelivery guard: which Telegram messages were already handled. Rows are
// pruned after a few days.
export const delivered = table('delivered', {
  chatId:    integer('chat_id').notNull(),
  messageId: integer('message_id').notNull(),
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
}, (t) => ({
  msgIdx:     uniqueIndex('uidx_delivered_msg').on(t.chatId, t.messageId),
  createdIdx: index('idx_delivered_created').on(t.createdAt),
}));

// Telegram channel → Bale channel/group mirrors. Set up by a user who is
// admin of both (checked at setup); problems are reported to that user.
export const channels = table('channels', {
  tgChannelId:    integer('tg_channel_id').primaryKey(),
  baleChatId:     integer('bale_chat_id').notNull(),
  ownerTgId:      integer('owner_tg_id').notNull(),
  linkedAt:       integer('linked_at').notNull().default(sql`(unixepoch())`),
  deliveredCount: integer('delivered_count').notNull().default(0),
  failedCount:    integer('failed_count').notNull().default(0),
  lockUntil:      integer('lock_until').notNull().default(0),   // one sender at a time
  probedAt:       integer('probed_at').notNull().default(0),    // last deletion check
}, (t) => ({
  ownerIdx: index('idx_channels_owner').on(t.ownerTgId),
}));

// Albums arrive as one update per item. Items wait here a few seconds until
// the first item's run (the leader) sends them together; rows are deleted as
// soon as the album is sent (cleanup removes leftovers). This is the only
// place message data (file references, caption) is held, and only briefly.
export const albums = table('albums', {
  key:       text('key').primaryKey(),                 // "<chat_id>:<media_group_id>"
  createdMs: integer('created_ms').notNull(),
  closed:    boolean('closed').notNull().default(false),
});

export const albumItems = table('album_items', {
  key:       text('key').notNull(),
  chatId:    integer('chat_id').notNull(),
  messageId: integer('message_id').notNull(),
  createdMs: integer('created_ms').notNull(),
  taken:     boolean('taken').notNull().default(false),
  item:      text('item').notNull(),                   // JSON: media reference + caption
}, (t) => ({
  msgIdx: uniqueIndex('uidx_album_items_msg').on(t.chatId, t.messageId),
  keyIdx: index('idx_album_items_key').on(t.key),
}));

// Channel mirror queue: posts, albums, edits and deletions waiting to be
// applied in Bale, strictly in Telegram order (sort_key = Telegram message
// id). A job stays until Bale accepts it, so nothing is lost while Bale is
// unreachable. `payload` holds the post (needed to send it) and is deleted
// with the job once it is done.
export const outbox = table('outbox', {
  id:          integer('id').primaryKey({ autoIncrement: true }),
  tgChannelId: integer('tg_channel_id').notNull(),
  sortKey:     integer('sort_key').notNull(),
  kind:        text('kind').notNull(),                 // post | album | edit | delete
  payload:     text('payload'),
  attempts:    integer('attempts').notNull().default(0),
  lastReason:  text('last_reason'),
  alerted:     boolean('alerted').notNull().default(false),
  createdAt:   integer('created_at').notNull().default(sql`(unixepoch())`),
}, (t) => ({
  orderIdx: index('idx_outbox_order').on(t.tgChannelId, t.sortKey, t.id),
}));

// Which Bale messages a mirrored Telegram post became (ids only), so edits
// and deletions can follow. layout: text | media | media+text (caption sent
// as separate text). Rows older than 30 days are pruned.
export const mirrored = table('mirrored', {
  tgChatId:    integer('tg_chat_id').notNull(),
  tgMessageId: integer('tg_message_id').notNull(),
  baleChatId:  integer('bale_chat_id').notNull(),
  baleIds:     text('bale_ids').notNull(),             // JSON array
  layout:      text('layout').notNull(),
  fileUid:     text('file_uid'),                       // Telegram file_unique_id
  createdAt:   integer('created_at').notNull().default(sql`(unixepoch())`),
  checkedAt:   integer('checked_at').notNull().default(0),
  missing:     integer('missing').notNull().default(0), // "not found" probes in a row
}, (t) => ({
  msgIdx:     uniqueIndex('uidx_mirrored_msg').on(t.tgChatId, t.tgMessageId),
  createdIdx: index('idx_mirrored_created').on(t.createdAt),
}));

// ── Telegram channel → Eitaa channel (via EitaaYar) ─────────────────────────
// Only ids, states, timestamps, counters and (encrypted) tokens: post
// contents are never stored. Failed posts are re-read from Telegram when
// they are retried.

// One mirror per Telegram channel. status: draft (mode not chosen yet) |
// pending (simple mode, waiting for the bot owner) | active | paused |
// stopped (the bot lost access; see stop_reason). mode: simple (the bot
// owner's EitaaYar account) | advanced (the user's own token, token_enc).
export const eitaaChannels = table('eitaa_channels', {
  tgChannelId:  integer('tg_channel_id').primaryKey(),
  ownerTgId:    integer('owner_tg_id').notNull(),
  mode:         text('mode'),
  status:       text('status').notNull().default('draft'),
  eitaaChatId:  text('eitaa_chat_id'),                 // numeric id or public username
  tokenEnc:     text('token_enc'),                     // advanced mode only
  albumPolicy:  text('album_policy').notNull().default('skip'), // skip | first
  notifyEdits:  boolean('notify_edits').notNull().default(true),
  stopReason:   text('stop_reason'),
  sentCount:    integer('sent_count').notNull().default(0),
  partialCount: integer('partial_count').notNull().default(0),
  failedCount:  integer('failed_count').notNull().default(0),
  alerted:      boolean('alerted').notNull().default(false), // "sending is stuck" told once
  lockUntil:    integer('lock_until').notNull().default(0),
  probedAt:     integer('probed_at').notNull().default(0),
  createdAt:    integer('created_at').notNull().default(sql`(unixepoch())`),
  linkedAt:     integer('linked_at'),
}, (t) => ({
  ownerIdx: index('idx_eitaa_channels_owner').on(t.ownerTgId),
}));

// Simple-mode requests waiting for the bot owner. eitaa_ref is what the user
// typed (shown to the owner only, never used for sending); the owner replies
// to owner_msg_id with the numeric id from the EitaaYar panel.
export const eitaaRequests = table('eitaa_requests', {
  id:            integer('id').primaryKey({ autoIncrement: true }),
  tgChannelId:   integer('tg_channel_id').notNull(),
  requesterTgId: integer('requester_tg_id').notNull(),
  eitaaRef:      text('eitaa_ref').notNull(),
  status:        text('status').notNull().default('pending'), // pending | approved | rejected | cancelled
  ownerMsgId:    integer('owner_msg_id'),
  createdAt:     integer('created_at').notNull().default(sql`(unixepoch())`),
  decidedAt:     integer('decided_at'),
}, (t) => ({
  statusIdx: index('idx_eitaa_requests_status').on(t.status),
  msgIdx:    index('idx_eitaa_requests_msg').on(t.ownerMsgId),
}));

// One row per Telegram post seen in a mirrored channel: its Eitaa message
// ids and outcome. status: queued (waiting / retrying) | done (complete) |
// partial (sent with issues) | skipped (nothing sent) | failed | deleted.
// issues: comma-separated codes (album, too_large, spoiler, …) — no content.
export const eitaaPosts = table('eitaa_posts', {
  tgChannelId: integer('tg_channel_id').notNull(),
  tgMessageId: integer('tg_message_id').notNull(),
  kind:        text('kind').notNull().default('post'), // post | album
  status:      text('status').notNull().default('queued'),
  eitaaIds:    text('eitaa_ids').notNull().default('[]'), // JSON array
  partsDone:   integer('parts_done').notNull().default(0), // resume point of a split post
  issues:      text('issues'),
  replyTo:     integer('reply_to'),                    // Telegram id the post replies to
  hadMarkup:   boolean('had_markup').notNull().default(false),
  editDate:    integer('edit_date').notNull().default(0),
  attempts:    integer('attempts').notNull().default(0),
  lastError:   text('last_error'),                     // short reason code
  createdAt:   integer('created_at').notNull().default(sql`(unixepoch())`),
  updatedAt:   integer('updated_at').notNull().default(sql`(unixepoch())`),
  checkedAt:   integer('checked_at').notNull().default(0),
}, (t) => ({
  msgIdx:     uniqueIndex('uidx_eitaa_posts_msg').on(t.tgChannelId, t.tgMessageId),
  statusIdx:  index('idx_eitaa_posts_status').on(t.tgChannelId, t.status),
  createdIdx: index('idx_eitaa_posts_created').on(t.createdAt),
}));

// Albums seen (one row per album, so only one notice/post per album).
export const eitaaAlbums = table('eitaa_albums', {
  tgChannelId:  integer('tg_channel_id').notNull(),
  mediaGroupId: text('media_group_id').notNull(),
  firstTgId:    integer('first_tg_id').notNull(),
  createdAt:    integer('created_at').notNull().default(sql`(unixepoch())`),
}, (t) => ({
  albumIdx:   uniqueIndex('uidx_eitaa_albums').on(t.tgChannelId, t.mediaGroupId),
  createdIdx: index('idx_eitaa_albums_created').on(t.createdAt),
}));

// What /eitaa_diag found out about EitaaYar (working HTML tags, limits,
// edit/delete methods) and short diagnostic state. key → JSON value.
export const eitaaSettings = table('eitaa_settings', {
  key:       text('key').primaryKey(),
  value:     text('value'),
  updatedAt: integer('updated_at').notNull().default(sql`(unixepoch())`),
});

// Bale API attempts that change something (send/edit/delete), for
// diagnosing duplicates and delays: timing, route and outcome only — no ids
// or contents. Kept short (pruned to the last few hundred rows).
export const baleCalls = table('bale_calls', {
  id:      integer('id').primaryKey({ autoIncrement: true }),
  atMs:    integer('at_ms').notNull(),
  callId:  text('call_id').notNull(),                 // one baleCall (its retries share it)
  attempt: integer('attempt').notNull(),
  method:  text('method').notNull(),
  ms:      integer('ms').notNull(),
  via:     text('via'),                                // relay | direct
  ok:      boolean('ok').notNull(),
  network: boolean('network').notNull(),
  code:    integer('code'),
  chatId:  integer('chat_id'),
  resultId: integer('result_id'),                     // message id Bale returned
});

// Burst test only (fake channel -42): who claimed, queued, locked and sent
// what, to find how a post reached Bale twice. Deleted by the test.
export const debugEvents = table('debug_events', {
  id:    integer('id').primaryKey({ autoIncrement: true }),
  atMs:  integer('at_ms').notNull(),
  kind:  text('kind').notNull(),                       // claim | job | acquire | release | send
  key:   integer('key'),
  runId: text('run_id'),
});
