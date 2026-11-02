import { table, integer, text, boolean, index, uniqueIndex, sql } from 'sdk/db';

// Privacy: only ids, link state, timestamps and counters are stored — never
// message contents, names or usernames. All timestamps are unix seconds.

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
}, (t) => ({
  baleIdx:     index('idx_users_bale_chat').on(t.baleChatId),
  lastSeenIdx: index('idx_users_last_seen').on(t.lastSeenAt),
}));

// Single-use linking codes. A code is consumed by setting used_at.
export const linkCodes = table('link_codes', {
  code:      text('code').primaryKey(),
  tgId:      integer('tg_id').notNull(),
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
  expiresAt: integer('expires_at').notNull(),
  usedAt:    integer('used_at'),
}, (t) => ({
  tgIdx:      index('idx_link_codes_tg').on(t.tgId),
  expiresIdx: index('idx_link_codes_expires').on(t.expiresAt),
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
