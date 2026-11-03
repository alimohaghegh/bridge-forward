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
