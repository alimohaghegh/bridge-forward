// Writes tgcloud/lib/config.js from CI secrets. The runtime has no env vars,
// so secrets are baked into this (git-ignored) module at deploy time.
// Never prints the values — only which optional ones are missing.
import { writeFileSync } from 'node:fs';

const token = (process.env.BALE_BOT_TOKEN || '').trim();
const owner = (process.env.OWNER_TELEGRAM_ID || '').trim();
// Optional (Eitaa mirroring). A missing value only disables its mode.
const eitaaToken = (process.env.EITAA_YAR_TOKEN || '').trim();
const operator = (process.env.EITAA_OPERATOR_USERNAME || '').trim().replace(/^@/, '');
const tokenKey = (process.env.EITAA_TOKEN_KEY || '').trim();

if (!token) {
  console.error('BALE_BOT_TOKEN is empty.');
  process.exit(1);
}
if (!/^\d+$/.test(owner) || !Number.isSafeInteger(Number(owner))) {
  console.error('OWNER_TELEGRAM_ID must be a numeric Telegram user id.');
  process.exit(1);
}

const validOperator = /^[A-Za-z][A-Za-z0-9_]{2,}$/.test(operator) ? operator : '';
if (!eitaaToken) console.log('::warning::EITAA_YAR_TOKEN is empty: Eitaa simple mode is disabled.');
if (!validOperator) console.log('::warning::EITAA_OPERATOR_USERNAME is empty or invalid: Eitaa simple mode is disabled.');
if (!tokenKey) console.log('::warning::EITAA_TOKEN_KEY is empty: Eitaa advanced mode is disabled.');

const content =
  '// Generated at deploy time by scripts/write-config.mjs. Do not commit.\n' +
  `export const BALE_BOT_TOKEN = ${JSON.stringify(token)};\n` +
  `export const OWNER_TELEGRAM_ID = ${Number(owner)};\n` +
  `export const EITAA_YAR_TOKEN = ${JSON.stringify(eitaaToken)};\n` +
  `export const EITAA_OPERATOR_USERNAME = ${JSON.stringify(validOperator)};\n` +
  `export const EITAA_TOKEN_KEY = ${JSON.stringify(tokenKey)};\n`;

writeFileSync('tgcloud/lib/config.js', content, { mode: 0o600 });
console.log('tgcloud/lib/config.js written.');
