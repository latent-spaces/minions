import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runSuites } from './all.mjs';
import { testEnvironment } from './support/disposable-session.mjs';

async function fixture(t) {
  const folder = await mkdtemp(join(tmpdir(), 'minions-runner-test-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  return folder;
}
const suite = (name, script, extra = {}) => ({ name, args: ['-e', script], cwd: process.cwd(), ...extra });
const quiet = { onResult() {} };

test('a failed suite preserves output, skips its dependents and continues independent checks', async t => {
  const folder = await fixture(t);
  const code = await runSuites([
    suite('failed', "console.log('stdout'); console.error('stderr'); process.exitCode = 2"),
    suite('dependent', "throw new Error('must not run')", { needs: ['failed'] }),
    suite('independent', "console.log('continued')"),
  ], { ...quiet, logDirectory: folder });
  assert.equal(code, 1);
  const summary = JSON.parse(await readFile(join(folder, 'summary.json'), 'utf8'));
  assert.deepEqual(summary.results.map(result => result.status), ['failed', 'skipped', 'passed']);
  assert.equal(summary.results[0].exitCode, 2);
  const log = await readFile(join(folder, 'failed.log'), 'utf8');
  assert.match(log, /stdout/); assert.match(log, /stderr/);
  assert.match(await readFile(join(folder, 'independent.log'), 'utf8'), /continued/);
});

test('a suite ignoring graceful shutdown is force-stopped after its timeout', async t => {
  const folder = await fixture(t);
  const started = Date.now();
  const code = await runSuites([suite('stubborn', `
    process.on('SIGINT', () => {}); process.on('SIGTERM', () => {});
    console.log('ready');
    setTimeout(() => process.exit(0), 10_000);
  `, { timeoutMs: 1000 })], { ...quiet, logDirectory: folder });
  assert.equal(code, 1);
  assert.ok(Date.now() - started < 8000, 'shutdown must not wait for the suite to exit by itself');
  const log = await readFile(join(folder, 'stubborn.log'), 'utf8');
  assert.match(log, /ready/); assert.match(log, /Suite timed out/);
});

test('a suite cleans descendants that outlive its root and hold output open', { skip: process.platform === 'win32' }, async t => {
  // Windows taskkill needs a live root; post-exit orphan cleanup is POSIX-only.
  const folder = await fixture(t);
  const started = Date.now();
  const steps = [suite('descendant', `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10_000)'], { stdio: 'inherit' });
    console.log('descendant:' + child.pid);
    child.unref();
  `)];
  // Exercise a top-level owner even when this file runs inside test:all's own
  // tree. Nested owners deliberately delegate orphan cleanup to the outer one.
  await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
    import { runSuites } from ${JSON.stringify(new URL('./all.mjs', import.meta.url).href)};
    process.exitCode = await runSuites(${JSON.stringify(steps)}, { logDirectory: ${JSON.stringify(folder)}, onResult() {} });
  `], { env: testEnvironment() });
  assert.ok(Date.now() - started < 8000, 'an inherited output descriptor must not keep the suite pending');
  const log = await readFile(join(folder, 'descendant.log'), 'utf8');
  const pid = Number(log.match(/descendant:(\d+)/)?.[1]);
  assert.ok(pid);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});
