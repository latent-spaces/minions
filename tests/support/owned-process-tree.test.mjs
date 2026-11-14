import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOwnedProcess, windowsTaskkillPath } from './owned-process-tree.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
async function waitFor(read, message, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await pause(20);
  }
  throw new Error(message);
}
async function ready(path) {
  return waitFor(async () => {
    try { return JSON.parse(await readFile(path, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
  }, 'Owned test tree never became ready.');
}
const fixture = `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const [mode, file] = process.argv.slice(2);
if (mode === 'grandchild') {
  process.on('SIGINT', () => {}); process.on('SIGTERM', () => {});
  writeFileSync(file, JSON.stringify({ child: process.ppid, grandchild: process.pid }));
  process.send?.('ready');
  setInterval(() => {}, 1000);
} else {
  const grandchild = spawn(process.execPath, [process.argv[1], 'grandchild', file], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  process.on('SIGINT', () => {}); process.on('SIGTERM', () => {});
  if (mode === 'failure') {
    // Exercise cleanup after the descendant exists, rather than racing its startup.
    const timeout = setTimeout(() => process.exit(8), 4000);
    grandchild.once('message', () => { clearTimeout(timeout); process.exit(7); });
  }
  else setInterval(() => {}, 1000);
}
`;

test('Windows cleanup fails clearly without the required executable and uses an absolute owned tool', () => {
  assert.throws(() => windowsTaskkillPath({}), /absolute SystemRoot/);
  assert.throws(() => windowsTaskkillPath({ SystemRoot: 'relative' }), /absolute SystemRoot/);
  assert.throws(() => windowsTaskkillPath({ SystemRoot: 'C:\\Windows' }, () => false), /taskkill/);
  assert.equal(windowsTaskkillPath({ SystemRoot: 'C:\\Windows' }, () => true), 'C:\\Windows\\System32\\taskkill.exe');
});

test('interruption stops the owned child and grandchild, including signal-resistant descendants, without killing a sibling', { timeout: 15_000 }, async () => {
  const folder = await mkdtemp(join(tmpdir(), 'mlswarm owned tree space '));
  const script = join(folder, 'tree.mjs'), marker = join(folder, 'ready.json');
  const sibling = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  const abort = new AbortController();
  let result, pids;
  try {
    await writeFile(script, fixture);
    result = runOwnedProcess(process.execPath, [script, 'hold', marker], { signal: abort.signal }, { graceMs: 250, forceMs: 2000 });
    result.catch(() => {});
    pids = await ready(marker);
    assert.ok(alive(pids.child)); assert.ok(alive(pids.grandchild));
    const started = Date.now(); abort.abort();
    assert.equal(await result, 130);
    await waitFor(() => !alive(pids.child) && !alive(pids.grandchild), 'Owned descendant survived interruption.');
    assert.ok(Date.now() - started < 8000);
    assert.ok(alive(sibling.pid), 'Cleanup targeted an unrelated sibling.');
  } finally {
    abort.abort(); await result?.catch(() => {});
    sibling.kill('SIGKILL');
    // Emergency cleanup is restricted to the exact PIDs created by this fixture.
    for (const pid of pids ? Object.values(pids) : []) { try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    await rm(folder, { recursive: true, force: true });
  }
});

test('nonzero POSIX child exit cleans its surviving process group', { skip: process.platform === 'win32', timeout: 10_000 }, async () => {
  const folder = await mkdtemp(join(tmpdir(), 'mlswarm owned failure '));
  let pids, result;
  try {
    const script = join(folder, 'tree.mjs'), marker = join(folder, 'ready.json');
    await writeFile(script, fixture);
    result = runOwnedProcess(process.execPath, [script, 'failure', marker], {}, { graceMs: 100, forceMs: 2000 });
    result.catch(() => {}); pids = await ready(marker);
    assert.equal(await result, 7);
    await waitFor(() => !alive(pids.grandchild), 'Owned descendant survived failed command.');
  } finally {
    await result?.catch(() => {});
    for (const pid of pids ? Object.values(pids) : []) { try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    await rm(folder, { recursive: true, force: true });
  }
});

test('nested launchers remain contained when the outer owner is interrupted', { timeout: 15_000 }, async () => {
  const folder = await mkdtemp(join(tmpdir(), 'mlswarm nested tree '));
  const abort = new AbortController();
  let result, pids;
  try {
    const script = join(folder, 'tree.mjs'), wrapper = join(folder, 'wrapper.mjs'), marker = join(folder, 'ready.json');
    await writeFile(script, fixture);
    await writeFile(wrapper, `import { runOwnedProcess } from ${JSON.stringify(new URL('./owned-process-tree.mjs', import.meta.url).href)};
      process.exitCode = await runOwnedProcess(process.execPath, ${JSON.stringify([script, 'hold', marker])});`);
    result = runOwnedProcess(process.execPath, [wrapper], { signal: abort.signal }, { graceMs: 350, forceMs: 2000 });
    result.catch(() => {}); pids = await ready(marker);
    abort.abort();
    assert.equal(await result, 130);
    await waitFor(() => !alive(pids.child) && !alive(pids.grandchild), 'Nested launcher left an owned descendant alive.');
  } finally {
    abort.abort(); await result?.catch(() => {});
    for (const pid of pids ? Object.values(pids) : []) { try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    await rm(folder, { recursive: true, force: true });
  }
});

test('a real POSIX termination signal reaches the owner and cleans its tree', { skip: process.platform === 'win32', timeout: 15_000 }, async () => {
  const folder = await mkdtemp(join(tmpdir(), 'mlswarm signal tree '));
  let owner, pids;
  try {
    const script = join(folder, 'tree.mjs'), wrapper = join(folder, 'owner.mjs'), marker = join(folder, 'ready.json');
    await writeFile(script, fixture);
    await writeFile(wrapper, `import { runOwnedProcess } from ${JSON.stringify(new URL('./owned-process-tree.mjs', import.meta.url).href)};
      process.exitCode = await runOwnedProcess(process.execPath, ${JSON.stringify([script, 'hold', marker])}, {}, { graceMs: 150, forceMs: 2000 });`);
    // This is an independent test owner: it must not inherit containment metadata
    // from a disposable test suite which happens to be running these guards.
    const env = { ...process.env }; delete env.MLSWARM_DISPOSABLE_TREE_MEMBER;
    owner = spawn(process.execPath, [wrapper], { stdio: ['ignore', 'ignore', 'pipe'], env });
    let diagnostics = ''; owner.stderr.on('data', value => { diagnostics += value; });
    const exited = new Promise((resolve, reject) => { owner.once('error', reject); owner.once('exit', resolve); });
    pids = await ready(marker); owner.kill('SIGTERM');
    assert.equal(await exited, 143, diagnostics);
    await waitFor(() => !alive(pids.child) && !alive(pids.grandchild), 'Signal owner left an owned descendant alive.');
  } finally {
    owner?.kill('SIGKILL');
    for (const pid of pids ? Object.values(pids) : []) { try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    await rm(folder, { recursive: true, force: true });
  }
});

test('argv, launch errors, exit failures and pre-aborted commands preserve their result and listener cleanup', async () => {
  const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
  const folder = await mkdtemp(join(tmpdir(), 'mlswarm owned argv '));
  try {
    const file = join(folder, 'argv.json'), argv = ['a b', 'a&b', '%PATH%', '$HOME', 'quote"single\''];
    assert.equal(await runOwnedProcess(process.execPath, ['-e', 'require("node:fs").writeFileSync(process.argv[1],JSON.stringify(process.argv.slice(2)))', file, ...argv]), 0);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), argv);
    assert.equal(await runOwnedProcess(process.execPath, ['-e', 'process.exit(7)']), 7);
    await assert.rejects(runOwnedProcess(join(folder, 'missing-executable'), []), error => error.code === 'ENOENT');
    assert.equal(await runOwnedProcess(join(folder, 'must-not-start'), [], { signal: AbortSignal.abort() }), 130);
    await assert.rejects(runOwnedProcess(process.execPath, [], { shell: true }), /shell-free/);
    await assert.rejects(runOwnedProcess(process.execPath, [], {}, { graceMs: Infinity }), /bounded/);
    assert.deepEqual([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')], before);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
