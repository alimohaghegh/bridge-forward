// Writes tgcloud/lib/config.js from CI secrets. The runtime has no env vars,
// so secrets are baked into this (git-ignored) module at deploy time.
// Never prints the values.
import { writeFileSync } from 'node:fs';

const token = (process.env.BALE_BOT_TOKEN || '').trim();
const owner = (process.env.OWNER_TELEGRAM_ID || '').trim();

if (!token) {
  console.error('BALE_BOT_TOKEN is empty.');
  process.exit(1);
}
if (!/^\d+$/.test(owner) || !Number.isSafeInteger(Number(owner))) {
  console.error('OWNER_TELEGRAM_ID must be a numeric Telegram user id.');
  process.exit(1);
}

const content =
  '// Generated at deploy time by scripts/write-config.mjs. Do not commit.\n' +
  `export const BALE_BOT_TOKEN = ${JSON.stringify(token)};\n` +
  `export const OWNER_TELEGRAM_ID = ${Number(owner)};\n`;

writeFileSync('tgcloud/lib/config.js', content, { mode: 0o600 });
console.log('tgcloud/lib/config.js written.');
