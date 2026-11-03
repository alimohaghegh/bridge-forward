// Loaded with `node --import ./tests/register.mjs`: the platform SDK
// ('sdk', 'sdk/db') and the generated secret config don't exist outside
// Telegram Serverless, so tests get small stand-ins.
import { register } from 'node:module';

register('./hooks.mjs', import.meta.url);
