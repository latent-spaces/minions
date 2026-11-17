import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const setupRoot = fileURLToPath(new URL('../', import.meta.url));

async function fixture(options, check) {
  const root = mkdtempSync(join(tmpdir(), 'minions update '));
  const upstream = join(root, 'upstream'), checkout = join(root, 'checkout'), events = join(root, 'events');
  const gitConfig = join(root, 'gitconfig');
  writeFileSync(gitConfig, '');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Synthetic Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Synthetic Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
    MINIONS_ENGINE_HOME: join(root, 'engine'), MINIONS_NO_BROWSER: '1', MINIONS_PLAIN: '1',
    MINIONS_UPDATE_TEST_EVENTS: events, MINIONS_UPDATE_TEST_DRAIN_FAIL: options.drainFails ? '1' : '0',
    MINIONS_UPDATE_TEST_SETUP_FAIL: options.setupFails ? '1' : '0',
    MINIONS_UPDATE_TEST_STATUS_UNKNOWN: options.statusUnknown ? '1' : '0',
    MINIONS_UPDATE_TEST_CHANGE_SOURCE: options.changeSource ? '1' : '0',
    MINIONS_UPDATE_TEST_REMOVE_UPSTREAM: options.pullFails ? upstream : '' };
  const git = (cwd, ...args) => {
    const result = spawnSync('git', args, { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return result.stdout.trim();
  };
  const put = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
  try {
    mkdirSync(upstream);
    git(upstream, 'init', '-b', 'main');
    for (const name of ['minions.mjs', 'engine-control.mjs', 'engine-plan.mjs']) {
      const destination = join(upstream, 'tools/setup', name);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(join(setupRoot, name), destination);
    }
    const connectorCommand = join(upstream, 'packages/agent-cli/src/connector-command.mjs');
    mkdirSync(dirname(connectorCommand), { recursive: true });
    copyFileSync(join(setupRoot, '../../packages/agent-cli/src/connector-command.mjs'), connectorCommand);
    put(join(upstream, 'packages/agent-cli/src/cli.mjs'), `
      import { appendFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
      if (process.argv[2] === 'service-status') {
        if (process.env.MINIONS_UPDATE_TEST_STATUS_UNKNOWN === '1') process.exitCode = 1;
        else console.log(JSON.stringify({ running: true }));
      }
      else if (process.argv[2] === 'service-stop') {
        appendFileSync(process.env.MINIONS_UPDATE_TEST_EVENTS, 'stop:' + readFileSync('version.txt', 'utf8') + '\\n');
        if (process.env.MINIONS_UPDATE_TEST_REMOVE_UPSTREAM) renameSync(process.env.MINIONS_UPDATE_TEST_REMOVE_UPSTREAM, process.env.MINIONS_UPDATE_TEST_REMOVE_UPSTREAM + '-moved');
        if (process.env.MINIONS_UPDATE_TEST_CHANGE_SOURCE === '1') writeFileSync('version.txt', 'concurrent edit');
        process.exitCode = process.env.MINIONS_UPDATE_TEST_DRAIN_FAIL === '1' ? 1 : 0;
      }
    `);
    put(join(upstream, 'tools/setup/engine-setup.mjs'), `
      import { appendFileSync, readFileSync } from 'node:fs';
      appendFileSync(process.env.MINIONS_UPDATE_TEST_EVENTS, 'setup:' + readFileSync('version.txt', 'utf8') + '\\n');
      process.exitCode = process.env.MINIONS_UPDATE_TEST_SETUP_FAIL === '1' ? 1 : 0;
    `);
    put(join(upstream, 'apps/server/dist/self-hosted-main.js'), '// synthetic built engine');
    put(join(upstream, 'version.txt'), 'old');
    git(upstream, 'add', '.'); git(upstream, 'commit', '-m', 'initial');
    git(root, 'clone', upstream, checkout);
    if (options.advance !== false) {
      put(join(upstream, 'version.txt'), 'new');
      git(upstream, 'add', '.'); git(upstream, 'commit', '-m', 'update');
    }
    if (options.diverge) {
      put(join(checkout, 'version.txt'), 'local');
      git(checkout, 'add', '.'); git(checkout, 'commit', '-m', 'local divergence');
    }
    if (options.stale) utimesSync(join(checkout, 'apps/server/dist/self-hosted-main.js'), new Date(1000), new Date(1000));
    // No engine is launched; reserve a free loopback port only for the real CLI's availability check.
    const server = createServer();
    await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
    env.MINIONS_ENGINE_PORT = String(server.address().port);
    await new Promise(accept => server.close(accept));
    const run = () => spawnSync(process.execPath, [join(checkout, 'tools/setup/minions.mjs'), options.command ?? 'update', ...(options.now ? ['--now'] : [])],
      { cwd: checkout, env, encoding: 'utf8', windowsHide: true, timeout: 15_000 });
    const readEvents = () => existsSync(events) ? readFileSync(events, 'utf8').trim().split('\n') : [];
    const result = run();
    await check({ result, recorded: readEvents(), version: readFileSync(join(checkout, 'version.txt'), 'utf8'), run, readEvents, env, checkout });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('update drains the old checkout before pulling and rebuilding the new source', () => fixture({}, ({ result, recorded, version }) => {
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.deepEqual(recorded, ['stop:old', 'setup:new']);
  assert.equal(version, 'new');
}));

test('an unfinished drain preserves the old checkout and skips rebuild', () => fixture({ drainFails: true }, ({ result, recorded, version }) => {
  assert.equal(result.status, 1);
  assert.deepEqual(recorded, ['stop:old']);
  assert.equal(version, 'old');
  assert.match(result.stderr, /checkout was left unchanged/);
}));

test('an up-to-date build leaves running turns alone', () => fixture({ advance: false }, ({ result, recorded }) => {
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.deepEqual(recorded, []);
  assert.match(result.stdout, /Already up to date/);
}));

test('a stale build still drains and rebuilds when main has no newer commit', () => fixture({ advance: false, stale: true }, ({ result, recorded }) => {
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.deepEqual(recorded, ['stop:old', 'setup:old']);
}));

test('divergent history is refused before stopping or changing the checkout', () => fixture({ diverge: true }, ({ result, recorded, version }) => {
  assert.equal(result.status, 1);
  assert.deepEqual(recorded, []);
  assert.equal(version, 'local');
  assert.match(result.stderr, /cannot fast-forward/);
}));

test('a pull failure after drain reports the stopped state and preserves source', () => fixture({ pullFails: true }, ({ result, recorded, version }) => {
  assert.equal(result.status, 1);
  assert.deepEqual(recorded, ['stop:old']);
  assert.equal(version, 'old');
  assert.match(result.stderr, /Minions is stopped; nothing was rebuilt/);
  assert.match(result.stderr, /minions start/);
}));

test('a failed rebuild reports how to finish setup', () => fixture({ setupFails: true }, ({ result, recorded, version }) => {
  assert.equal(result.status, 1);
  assert.deepEqual(recorded, ['stop:old', 'setup:new']);
  assert.equal(version, 'new');
  assert.match(result.stderr, /run minions setup to finish rebuilding and starting/);
}));

test('concurrent edits during drain are preserved and prevent pulling', () => fixture({ changeSource: true }, ({ result, recorded, version }) => {
  assert.equal(result.status, 1);
  assert.deepEqual(recorded, ['stop:old']);
  assert.equal(version, 'concurrent edit');
  assert.match(result.stderr, /checkout changed while turns were finishing/);
}));

test('update refuses unknown service state even with --now', () => fixture({ statusUnknown: true, now: true }, ({ result, recorded, version }) => {
  assert.equal(result.status, 1);
  assert.deepEqual(recorded, []);
  assert.equal(version, 'old');
  assert.match(result.stderr, /Resolve the service status before updating/);
}));

test('a failed setup is retried even when the backend build looks newer than the commit', () => fixture({ setupFails: true }, ({ result, run, readEvents, env, checkout }) => {
  assert.equal(result.status, 1);
  // A real setup can emit the backend before a later web/connector build fails.
  utimesSync(join(checkout, 'apps/server/dist/self-hosted-main.js'), new Date(), new Date());
  env.MINIONS_UPDATE_TEST_SETUP_FAIL = '0';
  const retried = run();
  assert.equal(retried.status, 0, retried.stderr || retried.error?.message);
  assert.deepEqual(readEvents(), ['stop:old', 'setup:new', 'stop:new', 'setup:new']);
  const completed = run();
  assert.equal(completed.status, 0, completed.stderr || completed.error?.message);
  assert.match(completed.stdout, /Already up to date/);
  assert.equal(readEvents().length, 4, 'a completed retry restores no-op behavior');
}));

test('plain status preserves an unreadable service state instead of claiming it stopped', () => fixture({ command: 'status', advance: false, statusUnknown: true }, ({ result, recorded }) => {
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /Shared service: unknown/);
  assert.doesNotMatch(result.stdout, /Shared service: stopped/);
  assert.deepEqual(recorded, [], 'status performs no stop or setup');
}));
