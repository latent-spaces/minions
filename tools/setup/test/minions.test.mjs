// The minions command loads, answers help and status in plain lines when piped, and refuses unknown commands.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../minions.mjs', import.meta.url));

async function freePort() {
  const server = createServer();
  await new Promise(accept => server.listen(0, '127.0.0.1', accept));
  const { port } = server.address();
  await new Promise(accept => server.close(accept));
  return port;
}

test('minions answers help, reports an empty installation and refuses an unknown command', async () => {
  const home = mkdtempSync(join(tmpdir(), 'minions cli '));
  try {
    const env = { ...process.env, MINIONS_ENGINE_HOME: join(home, 'engine'), MINIONS_ENGINE_PORT: String(await freePort()), MINIONS_NO_BROWSER: '1' };
    const minions = (...args) => spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8', windowsHide: true });
    const help = minions('help');
    assert.equal(help.status, 0);
    assert.match(help.stdout, /start \[--open\]/);
    const status = minions('status', '--json');
    assert.equal(status.status, 0);
    const value = JSON.parse(status.stdout);
    assert.equal(value.engine, 'free');
    assert.equal(value.initialized, 'new');
    assert.equal(value.service.running, false);
    const unknown = minions('dance');
    assert.equal(unknown.status, 2);
    assert.match(unknown.stdout, /Unknown command: dance/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
