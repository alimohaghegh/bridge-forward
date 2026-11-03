import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import * as texts from '../tgcloud/lib/texts.js';

const root = new URL('../tgcloud/', import.meta.url);
const sources = ['handlers/', 'lib/'].flatMap((dir) => readdirSync(new URL(dir, root))
  .filter((f) => f.endsWith('.js'))
  .map((f) => [dir + f, readFileSync(new URL(dir + f, root), 'utf8')]));

// A text removed by mistake would only fail when a user reaches that screen.
test('every text the code uses exists', () => {
  const missing = [];
  for (const [file, src] of sources) {
    for (const [, obj, key] of src.matchAll(/\b(T|E|B|MENU)\.([A-Za-z_][A-Za-z0-9_]*)\b/g)) {
      if (!texts[obj] || !(key in texts[obj])) missing.push(`${file}: ${obj}.${key}`);
    }
  }
  assert.deepEqual([...new Set(missing)], []);
});

test('the menu text is a character Telegram accepts (it refuses U+2800, U+200B, U+3164)', () => {
  assert.equal(texts.MENU.text, '⁣');
});

test('no user-facing text asks to type a command other than /start', () => {
  const offending = [];
  for (const obj of ['T', 'E', 'B', 'MENU']) {
    for (const [key, value] of Object.entries(texts[obj])) {
      if (/owner/i.test(key)) continue; // owner-only texts may name owner commands
      let s = typeof value === 'string' ? value : '';
      if (typeof value === 'function') {
        try {
          s = String(value('x', 'y', 'z'));
        } catch {
          s = String(value('x', ['y'], 'z'));
        }
      }
      const cmds = (s.match(/(^|\s)\/[a-z_]+/g) || []).map((c) => c.trim()).filter((c) => c !== '/start');
      if (cmds.length) offending.push(`${obj}.${key}: ${cmds.join(' ')}`);
    }
  }
  assert.deepEqual(offending, []);
});
