import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSuites, validationSteps } from './all.mjs';

test('suite failures and missing executables retain logs and do not hide independent results', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'mlswarm-runner space-'));
  try {
    const suites = [
      { name: 'fails', args: ['-e', 'console.error("failure evidence"); process.exit(7)'] },
      { name: 'blocked', args: ['-e', 'throw Error("must not execute")'], needs: ['fails'] },
      { name: 'missing', args: ['missing-file.mjs'], cwd: join(folder, 'absent') },
      { name: 'passes', args: ['-e', 'console.log("later suite ran")'] },
    ];
    const code = await runSuites(suites, { logDirectory: folder, onResult() {} });
    assert.equal(code, 1);
    const summary = JSON.parse(await readFile(join(folder, 'summary.json'), 'utf8'));
    assert.deepEqual(summary.results.map(result => result.status), ['failed', 'skipped', 'failed', 'passed']);
    assert.equal(summary.results[0].exitCode, 7);
    assert.match(await readFile(summary.results[0].log, 'utf8'), /failure evidence/);
    assert.match(await readFile(summary.results[3].log, 'utf8'), /later suite ran/);
    assert.match(summary.results[2].error, /ENOENT/);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('successful suite aggregation succeeds; aborted runs record skipped suites', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'mlswarm-runner-'));
  try {
    const suites = [{ name: 'first', args: ['-e', 'process.exit(0)'] }];
    assert.equal(await runSuites(suites, { logDirectory: folder, onResult() {} }), 0);
    assert.equal(await runSuites(suites, { logDirectory: folder, onResult() {}, signal: AbortSignal.abort() }), 1);
    assert.equal(JSON.parse(await readFile(join(folder, 'summary.json'), 'utf8')).results[0].status, 'skipped');
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('native Windows profile excludes POSIX launchers and keeps prerequisite build', () => {
  assert.throws(() => validationSteps('full', 'win32'), /POSIX/);
  assert.throws(() => validationSteps('unknown'), /profile/);
  const suites = validationSteps('portable', 'win32');
  assert.deepEqual(suites.slice(0, 2).map(suite => suite.name), ['contracts-build', 'connector-build']);
  assert.ok(suites.some(suite => suite.name === 'connector-native'));
  assert.ok(!suites.some(suite => /backend|release/.test(suite.name)));
});

test('interrupting a running suite records failure and skips later suites', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'mlswarm-runner-abort-'));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100);
  try {
    const code = await runSuites([
      { name: 'running', args: ['-e', 'setInterval(() => {}, 1000)'] },
      { name: 'later', args: ['-e', 'process.exit(0)'] },
    ], { logDirectory: folder, onResult() {}, signal: controller.signal });
    assert.equal(code, 1);
    const summary = JSON.parse(await readFile(join(folder, 'summary.json'), 'utf8'));
    assert.deepEqual(summary.results.map(result => result.status), ['failed', 'skipped']);
  } finally { clearTimeout(timer); await rm(folder, { recursive: true, force: true }); }
});

test('an unwritable suite log is a recorded failure and independent suites continue', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'mlswarm-runner-log-'));
  try {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(folder, 'blocked.log'));
    assert.equal(await runSuites([
      { name: 'blocked', args: ['-e', 'process.exit(0)'] },
      { name: 'later', args: ['-e', 'process.exit(0)'] },
    ], { logDirectory: folder, onResult() {} }), 1);
    const summary = JSON.parse(await readFile(join(folder, 'summary.json'), 'utf8'));
    assert.deepEqual(summary.results.map(result => result.status), ['failed', 'passed']);
    assert.match(summary.results[0].error, /Cannot open suite log/);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
