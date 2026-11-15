// Explicit owner Stop after the connector died. Synthetic processes only: no provider, model or cloud access.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openRuntimeStore } from '../src/service/store.mjs';
import { createRuntimeControllers } from '../src/service/controllers.mjs';
import { claimWorkerCheckout } from '../src/checkout-ownership.mjs';
import { missionMark } from '../src/leftover-processes.mjs';
import { stopOrphanedMission } from '../src/service/orphan-stop.mjs';

const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
const claims = registryRoot => readdirSync(registryRoot).filter(name => name.startsWith('claim-'));
async function started(child) {
  let stderr = ''; child.stderr.on('data', value => { stderr += value; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Synthetic service startup timeout: ${stderr}`)), 8000);
    child.once('message', value => { clearTimeout(timer); resolve(value); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Synthetic service exited ${code}: ${stderr}`)); });
  });
}
const crash = async child => { if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; } };

test('Stop after a connector crash kills the detached mission process, frees the checkout and ends the run', { timeout: 30000, skip: !['darwin', 'linux'].includes(process.platform) }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'minions-orphan-stop-'))), directory = join(root, 'ledger');
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' }); unrelated.unref();
  let child, serverPid, store, controllers;
  try {
    const missionId = randomUUID();
    child = fork(new URL('./fixtures/native-binding-leftover-crash.mjs', import.meta.url), [JSON.stringify({ root, missionId })],
      { env: { PATH: '/usr/bin:/bin', HOME: root }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const data = await started(child); serverPid = data.serverPid;
    const target = data.mission.target, ref = { missionId, generation: 1 }, query = { missionId, target };
    // The ledger the dead connector left: a bound run with a submitted turn whose result was never recorded.
    store = await openRuntimeStore({ directory });
    const { mission } = await store.accept({ version: 2, operationId: randomUUID(), kind: 'start', missionId, target,
      payload: { scope: 'Synthetic orphan, never execute a model.', deadlineAt: Date.now() + 300000, execution: { provider: 'claude', model: null } } });
    assert.equal(mission.generation, 1);
    await store.prepareCloudRun({ ...ref, startedAt: mission.createdAt }); await store.bindCloudRun({ ...ref, runId: missionId, cloudGeneration: 1 });
    const turnId = randomUUID(); await store.prepareTurn({ ...ref, turnId }); await store.markTurnSubmitted({ ...ref, turnId });
    await store.close(); store = undefined;
    await crash(child);
    assert.equal(alive(serverPid), true, 'the detached mission server outlives the connector');
    assert.equal(claims(data.registryRoot).length, 1);

    store = await openRuntimeStore({ directory });
    assert.equal((await store.getMission(query)).state, 'recovery_required');
    controllers = createRuntimeControllers({ store, adapterFactory: () => assert.fail('Stop must never construct a model adapter'),
      stopOrphanedMission: orphan => stopOrphanedMission(orphan, { folder: data.binding.folder, registryRoot: data.registryRoot }) });
    await controllers.accept({ version: 2, operationId: randomUUID(), kind: 'stop', ...query, generation: 1, payload: {} });

    const ended = await store.getMission(query);
    assert.equal(ended.state, 'stopped'); assert.equal(ended.currentTurnId, null); assert.equal(ended.guardPid, null);
    assert.equal(alive(serverPid), false, 'no worker process is left');
    assert.equal(alive(unrelated.pid), true, 'an unrelated same-user process is untouched');
    assert.deepEqual(claims(data.registryRoot), [], 'no checkout claim is left');
    assert.equal((await store.listReports(query)).reports.filter(report => report.kind === 'stop_run').length, 1, 'the engine run is ended');
    const next = await claimWorkerCheckout({ folder: data.binding.folder, agentId: target.agentId, project: target.projectId, registryRoot: data.registryRoot });
    next.release();
  } finally {
    await controllers?.close(); await store?.close(); await crash(child);
    for (const pid of [serverPid, unrelated.pid]) if (pid) try { process.kill(pid, 'SIGKILL'); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});

// A claim file written by a connector process that then died, without any model or guard.
async function deadConnectorClaim(t, phase) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'minions-orphan-claim-'))), folder = join(root, 'checkout'), registryRoot = join(root, 'claims');
  for (const path of [folder, registryRoot]) mkdirSync(path, { mode: 0o700 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const mission = { target: { site: 'https://orphan.invalid', ownerId: 'owner', projectId: 'park', agentId: 'claude' }, missionId: randomUUID(), generation: 1 };
  const child = fork(new URL('./fixtures/mission-recovery-crash.mjs', import.meta.url),
    [JSON.stringify({ claim: { folder, registryRoot, agentId: mission.target.agentId, project: mission.target.projectId, phase } })], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  try { await started(child); } finally { await crash(child); }
  assert.equal(claims(registryRoot).length, 1);
  return { folder, registryRoot, mission };
}

for (const phase of ['idle', 'spawning', 'running']) test(`the Windows job cleanup path releases a dead connector's ${phase} claim only after confirmed cleanup (simulated, not native Windows)`, async t => {
  const { folder, registryRoot, mission } = await deadConnectorClaim(t, phase), marks = [];
  await assert.rejects(stopOrphanedMission(mission, { folder, registryRoot, platform: 'win32',
    stopWindows: async () => { throw new Error('Windows mission cleanup is unconfirmed.'); }, stopMarked: () => assert.fail('POSIX sweep on Windows') }), /unconfirmed/);
  assert.equal(claims(registryRoot).length, 1, 'unconfirmed cleanup keeps the claim');
  assert.deepEqual(await stopOrphanedMission(mission, { folder, registryRoot, platform: 'win32',
    stopWindows: async mark => { marks.push(mark); return { cleanupConfirmed: true }; }, stopMarked: () => assert.fail('POSIX sweep on Windows') }), { stopped: 0, released: 1 });
  assert.deepEqual(marks, [missionMark(mission)]); assert.deepEqual(claims(registryRoot), []);
});

test('a worker another running connector still owns is never swept or released', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'minions-orphan-live-'))), folder = join(root, 'checkout'), registryRoot = join(root, 'claims');
  for (const path of [folder, registryRoot]) mkdirSync(path, { mode: 0o700 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const mission = { target: { site: 'https://orphan.invalid', ownerId: 'owner', projectId: 'park', agentId: 'claude' }, missionId: randomUUID(), generation: 1 };
  const live = await claimWorkerCheckout({ folder, registryRoot, agentId: 'claude', project: 'park' }); live.beginTurn();
  await assert.rejects(stopOrphanedMission(mission, { folder, registryRoot, stopMarked: () => assert.fail('swept a live worker'), stopWindows: () => assert.fail('swept a live worker') }), /still owns/);
  assert.equal(claims(registryRoot).length, 1);
  live.endTurn({ cleanupConfirmed: true }); live.release();
  assert.deepEqual(await stopOrphanedMission({ ...mission, missionId: randomUUID() }, { folder: join(root, 'checkout'), registryRoot: join(root, 'never-created'), stopMarked: async () => ({ stopped: 0 }) }), { stopped: 0, released: 0 });
});
