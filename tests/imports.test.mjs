import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';

// Every handler (and so every module it imports) must load: a missing export
// or a syntax error would otherwise only show up after a deploy.
test('all handlers load', async () => {
  const dir = new URL('../tgcloud/handlers/', import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const m = await import(new URL(f, dir).href);
    assert.equal(typeof m.default, 'function', f);
  }
});
