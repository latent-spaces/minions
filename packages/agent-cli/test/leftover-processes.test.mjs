import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { MISSION_MARK, markedProcesses, stopMarkedProcesses } from '../src/leftover-processes.mjs';

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const exits = new WeakMap();
function observeExit(child) {
  const state = { ended: false };
  state.done = new Promise(resolve => child.once('exit', () => { state.ended = true; resolve(); }));
  exits.set(child, state);
  return child;
}
async function waitForExit(child, timeoutMs = 1000) {
  const state = exits.get(child);
  if (state.ended) return true;
  let timer;
  try {
    return await Promise.race([state.done.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); })]);
  } finally { clearTimeout(timer); }
}
// A detached server in its own process group, like `nohup … &` in a worker turn.
function server(env, script = 'setInterval(() => {}, 1000)') {
  const child = observeExit(spawn(process.execPath, ['-e', script], { env: { ...process.env, ...env }, detached: true, stdio: 'ignore' }));
  child.unref();
  return child;
}
const settle = () => new Promise(resolve => setTimeout(resolve, 300));
// Hosted Linux runners may contain unrelated same-user processes whose environment
// is unreadable. Isolate lifecycle assertions to our real children; the separate
// capability test below still exercises production's complete fail-closed scan.
const readFixtureEntry = child => {
  assert.equal(statSync(`/proc/${child.pid}`).uid, process.getuid());
  return { pid: child.pid, text: readFileSync(`/proc/${child.pid}/environ`, 'utf8').replaceAll('\0', ' ') };
};
const fixtureList = (children, { platform = process.platform, readEntry = readFixtureEntry, exitWaitMs = 1000 } = {}) => platform !== 'linux' ? undefined : async () => {
  const entries = [];
  for (const child of children) {
    if (exits.get(child).ended) continue;
    try { entries.push(readEntry(child)); }
    catch (error) {
      if (['ENOENT', 'ESRCH'].includes(error.code)) continue;
      // Linux can deny /proc/environ while this exact child is exiting, before
      // libuv has reaped it. Only its ChildProcess exit event proves it is gone.
      if (['EACCES', 'EPERM'].includes(error.code) && await waitForExit(child, exitWaitMs)) continue;
      throw error;
    }
  }
  return entries;
};

test('a mission end stops only the processes that carry its marker', { skip: !['darwin', 'linux'].includes(process.platform) }, async () => {
  const mark = randomUUID().replaceAll('-', ''), other = randomUUID().replaceAll('-', '');
  const mine = server({ [MISSION_MARK]: mark });
  const stubborn = server({ [MISSION_MARK]: mark }, "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)");
  const theirs = server({ [MISSION_MARK]: other });
  const unmarked = server({});
  const list = fixtureList([mine, stubborn, theirs, unmarked]);
  try {
    await settle();
    assert.deepEqual((await markedProcesses(mark, { list })).sort(), [mine.pid, stubborn.pid].sort());
    assert.deepEqual(await stopMarkedProcesses(mark, { list, graceMs: 600, pollMs: 100 }), { stopped: 2 });
    await settle();
    assert.equal(alive(mine.pid), false);
    assert.equal(alive(stubborn.pid), false, 'a process that ignores SIGTERM is killed after the grace period');
    assert.equal(alive(theirs.pid), true);
    assert.equal(alive(unmarked.pid), true);
    assert.deepEqual(await stopMarkedProcesses(mark, { list }), { stopped: 0 });
  } finally {
    const children = [mine, stubborn, theirs, unmarked];
    for (const child of children) if (!exits.get(child).ended) child.kill('SIGKILL');
    const ended = await Promise.all(children.map(child => waitForExit(child)));
    assert.ok(ended.every(Boolean), 'each owned child must confirm exit during fixture cleanup');
  }
});


test('fixture inspection accepts an exiting child only after its exact exit event', async () => {
  const child = observeExit(Object.assign(new EventEmitter(), { pid: 12345 }));
  let reads = 0;
  const list = fixtureList([child], { platform: 'linux', readEntry: () => {
    reads++;
    queueMicrotask(() => child.emit('exit', null, 'SIGKILL'));
    throw Object.assign(new Error('Synthetic exiting child'), { code: 'EACCES' });
  } });
  assert.deepEqual(await list(), []);
  assert.deepEqual(await list(), []);
  assert.equal(reads, 1, 'an exited fixture is never confused with a reused PID');
});

test('fixture inspection propagates permission refusal without exact child exit proof', async () => {
  for (const code of ['EACCES', 'EPERM']) {
    const child = observeExit(Object.assign(new EventEmitter(), { pid: 12345 }));
    const refusal = Object.assign(new Error('Synthetic live child refusal'), { code });
    const list = fixtureList([child], { platform: 'linux', exitWaitMs: 20, readEntry: () => { throw refusal; } });
    await assert.rejects(list(), error => error === refusal);
    assert.equal(exits.get(child).ended, false);
  }
});

test('native enumeration confirms capability or refuses unreadable same-user environments before signaling', { skip: !['darwin', 'linux'].includes(process.platform) }, async t => {
  // This unused identity must match nothing; never signal a real runner process.
  const mark = randomUUID().replaceAll('-', '');
  let signals = 0;
  try {
    assert.deepEqual(await stopMarkedProcesses(mark, { kill: () => { signals++; throw new Error('Unexpected marked runner process'); } }), { stopped: 0 });
    t.diagnostic('Native same-user process enumeration succeeded; unused mission matched no processes.');
  } catch (error) {
    assert.equal(process.platform, 'linux');
    assert.equal(error.message, 'Mission cleanup could not inspect a same-user process.');
    assert.ok(['EACCES', 'EPERM'].includes(error.cause?.code));
    assert.match(error.cause?.path ?? '', /^\/proc\/[1-9]\d*\/environ$/);
    const processDirectory = error.cause.path.slice(0, -'/environ'.length);
    assert.equal(statSync(processDirectory).uid, process.getuid(), 'the inaccessible process independently belongs to this user');
    assert.throws(() => readFileSync(error.cause.path), cause => ['EACCES', 'EPERM'].includes(cause.code),
      'independently confirm that the host denies environment inspection');
    t.diagnostic('Host denies same-user /proc environment inspection: native global cleanup capability is unavailable and production correctly refused before signaling. Fixture-scoped lifecycle coverage runs separately.');
  }
  assert.equal(signals, 0, 'enumeration uncertainty must never signal a process');
});

test('a marker must be an exact mission identity token', async () => {
  await assert.rejects(markedProcesses('', { list: async () => [] }), /Invalid mission marker/);
  await assert.rejects(markedProcesses('.*', { list: async () => [] }), /Invalid mission marker/);
  const mark = 'a'.repeat(32);
  const list = async () => [{ pid: 11, text: `node x ${MISSION_MARK}=${mark}` }, { pid: 12, text: `node x ${MISSION_MARK}=${mark}b` }, { pid: process.pid, text: `${MISSION_MARK}=${mark}` }, { pid: 0, text: `${MISSION_MARK}=${mark}` }, { pid: -1, text: `${MISSION_MARK}=${mark}` }];
  assert.deepEqual(await markedProcesses(mark, { list }), [11]);
});

test('cleanup refuses enumeration and signal uncertainty instead of reporting success', async () => {
  const mark = 'a'.repeat(32);
  const list = async () => [{ pid: 12345, text: `${MISSION_MARK}=${mark}` }];
  await assert.rejects(stopMarkedProcesses(mark, { list: async () => { throw new Error('enumeration unavailable'); } }), /enumeration unavailable/);
  await assert.rejects(stopMarkedProcesses(mark, { list, kill: () => { throw Object.assign(new Error('not allowed'), { code: 'EPERM' }); } }), /could not signal/);
  await assert.rejects(stopMarkedProcesses(mark, { list, kill: () => {}, graceMs: 0, killGraceMs: 0 }), /unconfirmed/);
});

test('cleanup re-enumerates before escalation instead of killing a reused PID', async () => {
  const mark = 'c'.repeat(32), signals = []; let matched = true;
  const list = async () => [{ pid: 34567, text: matched ? `${MISSION_MARK}=${mark}` : 'unrelated replacement' }];
  assert.deepEqual(await stopMarkedProcesses(mark, { list, graceMs: 0, kill: (pid, signal) => { signals.push(signal); matched = false; } }), { stopped: 1 });
  assert.deepEqual(signals, ['SIGTERM']);
});
