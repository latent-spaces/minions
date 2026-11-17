import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureLinuxProcessBaseline, linuxProcessStartTick, linuxProcessesWithEnvironment, prepareMissionProcessBaseline, readLinuxProcessBaseline } from '../src/linux-process-baseline.mjs';
import { stopMarkedProcesses } from '../src/leftover-processes.mjs';
import { writePrivate } from '../src/state.mjs';

const posixTest = (name, fn) => test(name, { skip: process.platform === 'win32' }, fn);
const mark = 'a'.repeat(32), boot = '11111111-2222-3333-4444-555555555555';
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'minions-linux-proc-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'sys/kernel/random'), { recursive: true });
  writeFileSync(join(root, 'sys/kernel/random/boot_id'), boot);
  const addProcess = (pid, tick, text = '') => {
    mkdirSync(join(root, String(pid)), { recursive: true });
    writeFileSync(join(root, String(pid), 'stat'), `${pid} (a name (with) parens)) S ${Array(18).fill('0').join(' ')} ${tick} 0 0`);
    writeFileSync(join(root, String(pid), 'environ'), text);
  };
  let denied = 'EACCES';
  const read = (path, encoding) => {
    if (path === join(root, '100/environ') || path === join(root, '300/environ')) throw Object.assign(new Error('synthetic denial'), { code: denied });
    return readFileSync(path, encoding);
  };
  const options = { procRoot: root, read };
  return { root, addProcess, options, deny(code) { denied = code; } };
}

posixTest('only a matching pre-launch identity exempts an inaccessible Linux process; readable markers still stop', async t => {
  const f = fixture(t);
  f.addProcess(100, '9007199254740993');
  f.addProcess(200, '9007199254740994', `MINIONS_MISSION_MARK=${mark}\0`);
  const baseline = captureLinuxProcessBaseline(mark, f.options);
  assert.equal(linuxProcessStartTick(100, f.options), '9007199254740993');
  for (const code of ['EACCES', 'EPERM']) {
    f.deny(code);
    assert.deepEqual(linuxProcessesWithEnvironment({ ...f.options, baseline }).map(p => p.pid), [200]);
  }
  const signaled = [];
  const result = await stopMarkedProcesses(mark, { baseline, graceMs: 0, killGraceMs: 0,
    list: options => linuxProcessesWithEnvironment({ ...f.options, ...options }),
    kill(pid, signal) { signaled.push([pid, signal]); rmSync(join(f.root, String(pid)), { recursive: true }); } });
  assert.deepEqual(result, { stopped: 1 });
  assert.deepEqual(signaled, [[200, 'SIGTERM']]);
  assert.equal(existsSync(join(f.root, '100')), true);
});

posixTest('missing, reused, new and other-boot identities remain unconfirmed without signaling', async t => {
  const f = fixture(t); f.addProcess(100, '10');
  const baseline = captureLinuxProcessBaseline(mark, f.options), signaled = [];
  const stop = value => stopMarkedProcesses(mark, { baseline: value,
    list: options => linuxProcessesWithEnvironment({ ...f.options, ...options }), kill: pid => signaled.push(pid) });
  await assert.rejects(stop(null), /could not inspect/);
  f.addProcess(100, '11');
  await assert.rejects(stop(baseline), /could not inspect/);
  f.addProcess(100, '10'); f.addProcess(300, '12');
  await assert.rejects(stop(baseline), /could not inspect/);
  rmSync(join(f.root, '300'), { recursive: true });
  writeFileSync(join(f.root, 'sys/kernel/random/boot_id'), 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  await assert.rejects(stop(baseline), /could not inspect/);
  assert.deepEqual(signaled, []);
});

posixTest('unexpected inspection failures are never exempted by a baseline', t => {
  const f = fixture(t); f.addProcess(100, '10');
  const baseline = captureLinuxProcessBaseline(mark, f.options); f.deny('EIO');
  assert.throws(() => linuxProcessesWithEnvironment({ ...f.options, baseline }), /could not inspect/);
});

posixTest('capture and cleanup ignore processes owned by another user', t => {
  const f = fixture(t); f.addProcess(100, '10'); f.addProcess(400, '11');
  const uid = process.getuid();
  const options = { ...f.options, stat: path => ({ uid: path === join(f.root, '400') ? uid + 1 : uid }) };
  const baseline = captureLinuxProcessBaseline(mark, options);
  assert.deepEqual(Object.keys(baseline.processes), ['100']);
  assert.deepEqual(linuxProcessesWithEnvironment({ ...options, baseline }), []);
});

posixTest('private baseline records are bounded, mission-bound, strict and never backfilled for existing directories', t => {
  const f = fixture(t), state = join(f.root, 'state'); mkdirSync(state, { mode: 0o700 });
  const path = join(state, 'linux-process-baseline.json');
  prepareMissionProcessBaseline(state, mark, { platform: 'linux' });
  assert.equal(readLinuxProcessBaseline(state, mark), null);
  const baseline = captureLinuxProcessBaseline(mark, f.options);
  writePrivate(path, baseline);
  assert.deepEqual(readLinuxProcessBaseline(state, mark), baseline);
  f.addProcess(100, '20');
  prepareMissionProcessBaseline(state, mark, { platform: 'linux' });
  assert.deepEqual(readLinuxProcessBaseline(state, mark), baseline, 'existing missions never refresh the baseline');
  assert.throws(() => readLinuxProcessBaseline(state, 'b'.repeat(32)), /invalid/);
  writePrivate(path, { ...baseline, extra: true });
  assert.throws(() => readLinuxProcessBaseline(state, mark), /invalid/);
  writePrivate(path, '{broken');
  assert.throws(() => readLinuxProcessBaseline(state, mark));
  writePrivate(path, ' '.repeat(256 * 1024 + 1));
  assert.throws(() => readLinuxProcessBaseline(state, mark), /size limit/);
});
