import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const shot = fileURLToPath(new URL('../src/shot.cjs', import.meta.url));

test('the screenshot helper refuses an address without an image name, before looking for a browser', () => {
  for (const args of [[], ['index.html'], ['a.html', 'a.png', 'b.html']]) {
    const result = spawnSync(process.execPath, [shot, ...args], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^Usage: node shot\.cjs <address> <out\.png>/);
  }
});
