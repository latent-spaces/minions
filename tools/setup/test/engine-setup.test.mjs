// The setup command's early refusals, run for real: each must stop before installing or building anything.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../engine-setup.mjs', import.meta.url));

function listen(port = 0) {
  return new Promise((accept, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => accept(server));
  });
}

async function freePort() {
  const server = await listen();
  const { port } = server.address();
  await new Promise(accept => server.close(accept));
  return port;
}

function setup(env, args = []) {
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, MINIONS_NO_BROWSER: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.once('error', reject);
    child.once('exit', code => accept({ code, output }));
  });
}

function withHome(run) {
  return async () => {
    const home = mkdtempSync(join(tmpdir(), 'minions setup '));
    try { await run(join(home, 'engine')); } finally { rmSync(home, { recursive: true, force: true }); }
  };
}

const beforeInstall = output => assert.doesNotMatch(output, /\[2\/6\]/);

test('an interrupted first run is refused before anything is installed or changed', withHome(async home => {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'engine.sqlite'), '');
  const { code, output } = await setup({ MINIONS_ENGINE_HOME: home, MINIONS_ENGINE_PORT: String(await freePort()) });
  assert.equal(code, 1);
  assert.match(output, /stopped before initialization finished.*Nothing was changed/);
  beforeInstall(output);
}));

test('a first run without an owner identity stops before installing, not after the builds', withHome(async home => {
  const empty = join(home, '..', 'empty.gitconfig');
  writeFileSync(empty, '');
  const { code, output } = await setup({ MINIONS_ENGINE_HOME: home, MINIONS_ENGINE_PORT: String(await freePort()),
    GIT_CONFIG_GLOBAL: empty, GIT_CONFIG_NOSYSTEM: '1' }, ['--owner-name', 'Ana Lee']);
  assert.equal(code, 1);
  assert.match(output, /--owner-email/);
  beforeInstall(output);
}));

test('a port held by another program is refused, and that program is left alone', withHome(async home => {
  const server = await listen();
  try {
    const { code, output } = await setup({ MINIONS_ENGINE_HOME: home, MINIONS_ENGINE_PORT: String(server.address().port) });
    assert.equal(code, 1);
    assert.match(output, /is occupied.*Nothing was started or stopped/);
    beforeInstall(output);
    assert.equal(server.listening, true);
  } finally { await new Promise(accept => server.close(accept)); }
}));
