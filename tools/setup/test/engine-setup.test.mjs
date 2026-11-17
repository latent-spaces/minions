// The setup command's early refusals, run for real: each must stop before installing or building anything.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    // A variable given as undefined is left out of the child's environment.
    const merged = Object.fromEntries(Object.entries({ ...process.env, MINIONS_NO_BROWSER: '1', ...env }).filter(([, value]) => value !== undefined));
    const child = spawn(process.execPath, [script, ...args], { env: merged, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
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

test('a chosen port held by another program is refused, and that program is left alone', withHome(async home => {
  const server = await listen();
  try {
    const { code, output } = await setup({ MINIONS_ENGINE_HOME: home, MINIONS_ENGINE_PORT: String(server.address().port) });
    assert.equal(code, 1);
    assert.match(output, /is used by .*so the engine could not start there.*Nothing was started or stopped/);
    beforeInstall(output);
    assert.equal(server.listening, true);
  } finally { await new Promise(accept => server.close(accept)); }
}));

test('a first run with 8787 held stops instead of moving to another port', withHome(async home => {
  // 8787 is held here, or already by another program on this computer; either way it is not this new engine.
  const held = await listen(8787).catch(() => null);
  try {
    const { code, output } = await setup({ MINIONS_ENGINE_PORT: undefined, MINIONS_ENGINE_HOME: home });
    assert.equal(code, 1);
    assert.match(output, /Port 8787 is used by .*so the engine could not start there/);
    // Process identification is best-effort: minimal Linux installs need not have lsof.
    if (held) assert.equal(held.listening, true);
    beforeInstall(output);
  } finally { if (held) await new Promise(accept => held.close(accept)); }
}));

test('setup saves the chosen port before waiting for the engine, so a slow start is still found by the next setup and stop', () => {
  // Running setup to that step needs the full build, so this pins the order in the source.
  const source = readFileSync(script, 'utf8');
  const saved = source.indexOf('writeFileSync(files.settingsFile, settingsText(port)'), started = source.indexOf('await startEngine(engineEnv, files)');
  assert.ok(saved > 0 && started > 0 && saved < started);
});
