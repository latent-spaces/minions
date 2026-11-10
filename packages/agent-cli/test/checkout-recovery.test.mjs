import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { claimWorkerCheckout } from '../src/checkout-ownership.mjs';
import { createNativeAdapterFactory } from '../src/service/native-bindings.mjs';
import { makeMixedNativeFixtures, nativeEvents } from './fixtures/mixed-native-fixtures.mjs';

const host = new URL('./fixtures/checkout-crash-host.mjs', import.meta.url);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
async function until(read, predicate, label) {
  const deadline = Date.now() + 6000;
  let value;
  while (Date.now() < deadline) { value = await read(); if (predicate(value)) return value; await sleep(10); }
  assert.fail(`Timed out: ${label}; last value ${JSON.stringify(value)}`);
}
async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const done = once(child, 'exit'); child.kill('SIGKILL'); await done;
}
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mlswarm-checkout-crash-')));
  const parent = join(root, 'work'), folder = join(parent, 'repo'), child = join(folder, 'subdir');
  const unrelated = join(root, 'unrelated'), registryRoot = join(root, 'registry');
  for (const path of [child, unrelated, registryRoot]) await mkdir(path, { recursive: true, mode: 0o700 });
  // A separate installation's path spelling resolves to the same private registry.
  // Symlink storage itself is intentionally forbidden by the private-state layer.
  const registryAlias = `${registryRoot}/.`;
  const options = { root, parent, folder, child, unrelated, registryRoot, registryAlias,
    agentId: 'original-agent', project: 'original-project', nativeEvidence: join(root, 'native-evidence.json') };
  const processes = [];
  t.after(async () => {
    // Exact disposable process identities only; the recorded native PID is the
    // detached group leader, verified before any crash. Never scan other processes.
    for (const value of processes) {
      // Preserve exact fake native identities even if the fixture failed between
      // creating its descendant and sending the final ready IPC message.
      try { Object.assign(value, JSON.parse(await readFile(options.nativeEvidence, 'utf8'))); }
      catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
      if (value.nativePid && [value.nativePid, value.descendantPid].some(pid => pid && alive(pid))) {
        try { process.kill(-value.nativePid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
      await stopChild(value.service);
      if (value.guardPid && alive(value.guardPid)) process.kill(value.guardPid, 'SIGKILL');
      if (value.nativePid) await until(() => alive(value.nativePid), value => !value, 'native cleanup');
      if (value.descendantPid) await until(() => alive(value.descendantPid), value => !value, 'descendant cleanup');
    }
    await rm(root, { recursive: true, force: true });
  });
  return { ...options, async launch(phase) {
    const service = fork(host, ['service', JSON.stringify({ ...options, phase })], {
      env: { HOME: root, PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    const value = { service }; processes.push(value);
    let stderr = ''; service.stderr.on('data', value => { stderr += value; });
    const result = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { cleanup(); reject(new Error(`Fixture startup timed out: ${stderr}`)); }, 6000);
      const cleanup = () => { clearTimeout(timeout); service.off('message', message); service.off('exit', exited); service.off('error', failed); };
      const failed = error => { cleanup(); reject(error); };
      const exited = code => { cleanup(); reject(new Error(`Fixture exited ${code}: ${stderr}`)); };
      const message = update => {
        Object.assign(value, update);
        if (update.ready) { cleanup(); resolve(update); }
      };
      service.on('message', message); service.once('exit', exited); service.once('error', failed);
    });
    Object.assign(value, result);
    if (value.nativePid) {
      const group = execFileSync('/bin/ps', ['-o', 'pgid=', '-p', String(value.nativePid)], { encoding: 'utf8' }).trim();
      assert.equal(Number(group), value.nativePid, 'retain exact detached native group identity before crashes');
      const childGroup = execFileSync('/bin/ps', ['-o', 'pgid=', '-p', String(value.descendantPid)], { encoding: 'utf8' }).trim();
      assert.equal(Number(childGroup), value.nativePid);
    }
    return value;
  } };
}
async function records(ctx) {
  const names = (await readdir(ctx.registryRoot)).filter(name => name.startsWith('claim-'));
  return Promise.all(names.map(async name => ({ path: join(ctx.registryRoot, name), value: JSON.parse(await readFile(join(ctx.registryRoot, name), 'utf8')) })));
}
const acquire = (ctx, folder = ctx.folder) => claimWorkerCheckout({ folder, agentId: 'different-agent', project: 'different-project', registryRoot: ctx.registryAlias });

test('guard SIGKILL then service SIGKILL never releases overlapping checkouts while detached fake native work survives', { timeout: 15000 }, async t => {
  const ctx = await fixture(t), run = await ctx.launch('running');
  const before = await records(ctx); assert.equal(before.length, 1);
  assert.equal(before[0].value.schema, 2); assert.equal(before[0].value.guardPid, run.guardPid); assert.equal(before[0].value.nativePid, run.nativePid);
  process.kill(run.guardPid, 'SIGKILL');
  await until(() => alive(run.guardPid), value => !value, 'guard crash');
  await stopChild(run.service);
  assert.equal(alive(run.nativePid), true); assert.equal(alive(run.descendantPid), true);
  for (const folder of [ctx.folder, ctx.parent, ctx.child]) await assert.rejects(acquire(ctx, folder), /owned|uncertain|cleanup/i);
  assert.deepEqual(await records(ctx), before, 'failed acquisition preserves original evidence');
  const other = await acquire(ctx, ctx.unrelated); other.release();
  process.kill(run.nativePid, 'SIGKILL');
  await until(() => alive(run.nativePid), value => !value, 'native leader crash');
  assert.equal(alive(run.descendantPid), true, 'leader absence does not mean descendant cleanup');
  await assert.rejects(acquire(ctx), /owned|uncertain|cleanup/i);
  process.kill(-run.nativePid, 'SIGKILL');
  await until(() => alive(run.descendantPid), value => !value, 'exact fake group cleanup');
  await assert.rejects(acquire(ctx), /owned|uncertain|cleanup/i, 'all recorded PIDs absent still does not manufacture trusted cleanup');
  assert.deepEqual(await records(ctx), before);
});

for (const invalid of ['schema1', 'malformed']) test(`${invalid} checkout claims refuse hard cutover without changing evidence`, async t => {
  const ctx = await fixture(t), claim = await acquire(ctx);
  const [{ path, value }] = await records(ctx);
  const old = invalid === 'schema1' ? { ...value, schema: 1, children: [] } : { ...value, nativePid: 'uncertain' };
  const bytes = JSON.stringify(old); await writeFile(path, bytes, { mode: 0o600 });
  await assert.rejects(acquire(ctx), /uncertain|schema|record/i);
  assert.equal(await readFile(path, 'utf8'), bytes);
  // Restore only this test-owned record to allow its idle handle to release.
  await writeFile(path, JSON.stringify(value), { mode: 0o600 }); claim.release();
});

test('actual native binding records both guard and native identities, then releases only proven cleanup (fake Claude)', { timeout: 15000 }, async t => {
  const ctx = await fixture(t), gate = join(ctx.root, 'complete-fake-turn');
  const fixtures = await makeMixedNativeFixtures(ctx.root, [['synthetic', 'claude']], () => [{ gate }]);
  const factory = createNativeAdapterFactory({ ...fixtures, registryRoot: ctx.registryRoot });
  const binding = fixtures.bindings[0];
  const adapter = await factory({ target: binding.target, missionId: randomUUID(), generation: 1,
    execution: { provider: 'claude', model: null }, scope: 'Synthetic checkout evidence only' });
  const controller = new AbortController();
  let observedGuard, observedNative;
  const running = adapter.run({ prompt: 'Synthetic fixture only', signal: controller.signal, deadline: Date.now() + 10000,
    onGuardStarted: pid => { observedGuard = pid; }, onModelStarted: pid => { observedNative = pid; } });
  try {
    await until(() => nativeEvents(fixtures.events), values => values.length > 0, 'actual binding native stand-in');
    const record = await until(async () => (await records(ctx))[0]?.value, value => value?.phase === 'running' && value.nativePid, 'native identity saved');
    assert.equal(record.guardPid, observedGuard); assert.equal(record.nativePid, observedNative);
    assert.notEqual(record.guardPid, record.nativePid);
    await assert.rejects(acquire(ctx, binding.folder), /owned|uncertain|cleanup/i);
    await writeFile(gate, 'go');
    const result = await running;
    assert.equal(result.cleanupConfirmed, true); assert.equal(Boolean(result.failed), false);
    assert.equal((await records(ctx))[0].value.phase, 'spawning', 'mission retains resources between clean native turns');
  } finally {
    controller.abort();
    const result = await running;
    await adapter.release({ cleanupConfirmed: result.cleanupConfirmed });
  }
  assert.deepEqual(await records(ctx), []);
});
