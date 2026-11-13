import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const shot = fileURLToPath(new URL('../src/shot.cjs', import.meta.url));

test('the screenshot helper refuses an address without an image name, before looking for a browser', () => {
  for (const args of [[], ['index.html'], ['a.html', 'a.png', 'b.html']]) {
    const result = spawnSync(process.execPath, [shot, ...args], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^Usage: node shot\.cjs <address> <out\.png>/);
  }
});

test('a local page is served from its folder, so its module scripts run, and a missing page fails', { timeout: 90_000 }, async t => {
  const { mkdtempSync, writeFileSync, rmSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const folder = mkdtempSync(join(tmpdir(), 'mlswarm-shot-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  writeFileSync(join(folder, 'part.js'), "export const word = 'ready';\n");
  writeFileSync(join(folder, 'page.html'), '<script type="module">import { word } from "./part.js"; document.title = word;</script>');
  try { require('playwright'); } catch { t.skip('Playwright is not installed here'); return; }
  const ok = spawnSync(process.execPath, [shot, join(folder, 'page.html'), join(folder, 'page.png')], { encoding: 'utf8', timeout: 70_000 });
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(statSync(join(folder, 'page.png')).size > 0);
  const missing = spawnSync(process.execPath, [shot, join(folder, 'none.html'), join(folder, 'none.png')], { encoding: 'utf8', timeout: 70_000 });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /answered 404/);
});
