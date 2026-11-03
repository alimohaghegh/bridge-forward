// Test values; a test may override them by setting globalThis.__testConfig
// before importing the modules under test.
const o = globalThis.__testConfig || {};
export const BALE_BOT_TOKEN = o.BALE_BOT_TOKEN || 'test-bale-token';
export const OWNER_TELEGRAM_ID = 1;
export const EITAA_YAR_TOKEN = '';
export const EITAA_OPERATOR_USERNAME = '';
export const EITAA_TOKEN_KEY = '';
export const EITAA_RELAY_URL = o.EITAA_RELAY_URL || '';
export const EITAA_RELAY_KEY = o.EITAA_RELAY_KEY || '';
