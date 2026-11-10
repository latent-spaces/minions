import test from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { connectClients } from '../src/client-setup.mjs';
import { ensureInstallation } from '../src/service/installation.mjs';

async function computer(t) {
  const root = mkdtempSync(join(tmpdir(), 'mlswarm-clients-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'service'), userHome = join(root, 'user');
  await ensureInstallation({ home, site: 'http://127.0.0.1:8787' });
  mkdirSync(join(userHome, '.claude', 'skills', 'mlswarm'), { recursive: true });
  mkdirSync(join(userHome, '.codex'), { recursive: true });
  return { home, userHome, env: {} };
}

test('running setup again leaves already connected settings files untouched', async t => {
  const where = await computer(t), { userHome } = where;
  // Formatted differently from what setup writes, as a running client might save it.
  writeFileSync(join(userHome, '.claude.json'), JSON.stringify({ theme: 'dark' }));
  connectClients(where);
  const files = [join(userHome, '.claude.json'), join(userHome, '.claude', 'settings.json'), join(userHome, '.codex', 'config.toml')];
  const claude = JSON.parse(readFileSync(files[0], 'utf8'));
  writeFileSync(files[0], JSON.stringify(claude));
  const before = files.map(file => [lstatSync(file).ino, readFileSync(file, 'utf8')]);
  assert.deepEqual(connectClients(where).map(r => r.connected), [true, true]);
  assert.deepEqual(files.map(file => [lstatSync(file).ino, readFileSync(file, 'utf8')]), before);
});
