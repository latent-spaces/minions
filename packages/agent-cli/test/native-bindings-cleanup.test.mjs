import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { makeMixedNativeFixtures } from './fixtures/mixed-native-fixtures.mjs';
import { createNativeAdapterFactory } from '../src/service/native-bindings.mjs';
import { inspectWorkerCheckout } from '../src/checkout-ownership.mjs';

for (const failure of ['sweep', 'revoke']) test(`mission release retains its checkout after ${failure} uncertainty and allows exact cleanup retry (no models)`, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mlswarm-cleanup-binding-')));
  let blocked = true, adapter, revocations = 0, sweeps = 0;
  try {
    const fixtures = await makeMixedNativeFixtures(root, [['garden', 'claude']]);
    fixtures.registryRoot = join(root, 'claims');
    const binding = fixtures.bindings[0], createBridge = binding.createBridge;
    binding.createBridge = async (...args) => {
      const issued = await createBridge(...args);
      return { ...issued, revoke: async () => {
        revocations++;
        if (failure === 'revoke' && blocked) throw new Error('Synthetic revocation uncertainty');
        await issued.revoke();
      } };
    };
    fixtures.adapterFactory = async () => ({
      stopLeftovers: async () => { sweeps++; if (failure === 'sweep' && blocked) throw new Error('Synthetic sweep uncertainty'); },
      run: async () => ({ cleanupConfirmed: true }),
    });
    const factory = createNativeAdapterFactory(fixtures);
    const mission = { target: binding.target, missionId: randomUUID(), generation: 1, execution: { provider: 'claude', model: null }, scope: 'Synthetic cleanup' };
    adapter = await factory(mission);
    const inspect = () => inspectWorkerCheckout({ folder: binding.folder, agentId: binding.target.agentId, project: binding.target.projectId, registryRoot: fixtures.registryRoot });
    await adapter.run({});
    await assert.rejects(adapter.release({ cleanupConfirmed: true }), /Synthetic .* uncertainty/);
    assert.equal(inspect().exactClaims[0].phase, 'spawning', 'failed cleanup leaves a non-idle durable ownership claim');
    await assert.rejects(factory({ ...mission, missionId: randomUUID() }), /already owned/);
    if (failure === 'sweep') assert.equal(revocations, 0, 'do not revoke before stopping detached processes');
    blocked = false;
    await adapter.release({ cleanupConfirmed: true });
    assert.equal(inspect().exactClaims.length, 0);
    const sweepCount = sweeps;
    await adapter.release({ cleanupConfirmed: true });
    assert.equal(sweeps, sweepCount, 'repeated successful release is a no-op');
  } finally {
    blocked = false;
    await adapter?.release({ cleanupConfirmed: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('service death between turns preserves the exact checkout claim while detached mission resources survive', { timeout: 15000, skip: !['darwin', 'linux'].includes(process.platform) }, async () => {
  const { fork, spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const { readFile } = await import('node:fs/promises');
  const { createLocalWorkerAdapter } = await import('../src/native-worker-adapter.mjs');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mlswarm-between-turn-crash-')));
  let child, serverPid;
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' }); unrelated.unref();
  const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
  try {
    child = fork(new URL('./fixtures/native-binding-leftover-crash.mjs', import.meta.url), [JSON.stringify({ root, missionId: randomUUID() })],
      { env: { PATH: '/usr/bin:/bin', HOME: root }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let stderr = ''; child.stderr.on('data', value => { stderr += value; });
    const data = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Synthetic service startup timeout: ${stderr}`)), 8000);
      child.once('message', value => { clearTimeout(timer); resolve(value); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Synthetic service exited ${code}: ${stderr}`)); });
    });
    serverPid = data.serverPid;
    const inspect = () => inspectWorkerCheckout({ ...data.binding, agentId: data.binding.target.agentId, project: data.binding.target.projectId, registryRoot: data.registryRoot });
    const before = inspect(); assert.equal(before.exactClaims.length, 1); assert.equal(before.exactClaims[0].phase, 'spawning');
    assert.equal(alive(serverPid), true);
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    const binding = { ...data.binding, createBridge: async () => ({ url: `http://127.0.0.1:12345/worker/${'a'.repeat(32)}/mcp`, token: 'synthetic', revoke: async () => {} }),
      readProjectState: async () => ({}), prepareParticipation: async () => null };
    const factory = createNativeAdapterFactory({ bindings: [binding], registryRoot: data.registryRoot, executables: data.executables, envSource: data.envSource });
    for (const mission of [data.mission, data.mission, { ...data.mission, generation: 2 }]) await assert.rejects(factory(mission), /already owned/);
    assert.equal(inspect().exactClaims[0].id, before.exactClaims[0].id, 'retries never delete or replace the retained claim');
    assert.equal(alive(serverPid), true, 'failed takeover never kills the mission server');
    const identity = { target: data.mission.target, missionId: data.mission.missionId, generation: 1, provider: 'claude', model: null };
    const native = await createLocalWorkerAdapter({ client: 'claude', folder: binding.folder,
      stateDir: join(binding.stateDir, `mission-${data.mission.missionId}-1`), journalIdentity: identity,
      executables: data.executables, envSource: data.envSource, bridge: {}, prepareParticipation: async () => null });
    assert.deepEqual(await native.stopLeftovers(), { stopped: 1 }, 'exact durable identity can still clean its own detached process');
    assert.equal(alive(unrelated.pid), true);
    assert.equal(inspect().exactClaims[0].id, before.exactClaims[0].id, 'cleanup does not silently delete ownership evidence');
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGKILL'); await done; }
    if (!serverPid) { try { serverPid = Number(await readFile(join(root, 'detached.pid'), 'utf8')); } catch {} }
    for (const pid of [serverPid, unrelated.pid]) if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
    rmSync(root, { recursive: true, force: true });
  }
});

test('native binding joins measured prompt sizes with facade counters and closes measurement on failure', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mlswarm-context-binding-')));
  let adapter, begin = 0, end = 0, broken = false;
  try {
    const fixtures = await makeMixedNativeFixtures(root, [['garden', 'claude']]);
    fixtures.registryRoot = join(root, 'claims');
    const binding = fixtures.bindings[0], createBridge = binding.createBridge;
    binding.createBridge = async (...args) => ({...await createBridge(...args),
      beginContext: async () => { begin++; },
      endContext: async () => { end++; return {catalogRequests:0,catalogBytes:0,tools:[]}; },
    });
    fixtures.adapterFactory = async () => ({stopLeftovers:async()=>{},run:async()=>{
      if (broken) throw new Error('Synthetic native failure');
      return {cleanupConfirmed:true,usage:{context:{instructionBytes:12,turnPromptBytes:34}}};
    }});
    const mission = {target:binding.target,missionId:randomUUID(),generation:1,execution:{provider:'claude',model:null},scope:'Synthetic context'};
    adapter = await createNativeAdapterFactory(fixtures)(mission);
    const result = await adapter.run({});
    assert.deepEqual(result.usage.context, {instructionBytes:12,turnPromptBytes:34,catalogRequests:0,catalogBytes:0,tools:[],scope:'mlswarm-supplied',coverage:'partial'});
    broken = true;
    await assert.rejects(adapter.run({}), /Synthetic native failure/);
    assert.equal(begin,2); assert.equal(end,2);
  } finally {
    await adapter?.release({cleanupConfirmed:true});
    rmSync(root,{recursive:true,force:true});
  }
});
