// Waiting survives a connector restart (owner decision, 9 November 2026). Synthetic native protocols and a
// fake cloud only: no provider, model, credential or network access.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, realpath, writeFile } from 'node:fs/promises';
import { mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openRuntimeStore } from '../src/service/store.mjs';
import { createRuntimeControllers } from '../src/service/controllers.mjs';
import { createNativeAdapterFactory } from '../src/service/native-bindings.mjs';
import { stopOrphanedMission } from '../src/service/orphan-stop.mjs';
import { makeMixedNativeFixtures, nativeEvents } from './fixtures/mixed-native-fixtures.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const query = mission => ({ missionId: mission.missionId, target: mission.target });
const command = (mission, kind, payload = {}) => ({ version: 2, operationId: randomUUID(), kind, ...query(mission), generation: mission.generation, payload });
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
async function until(read, predicate, label) {
  const deadline = Date.now() + 12000; let value;
  while (Date.now() < deadline) { value = await read(); if (predicate(value)) return value; await sleep(15); }
  assert.fail(`Timed out: ${label}; ${JSON.stringify(value)}`);
}
// The fake cloud answers every session sync with the job's end time once the owner added time, and its token cap.
function fakeCloud() {
  const cloud = { authorized: undefined, sessions: [], starts: 0, news: { project: { started: true, paused: false, closed: false }, pending: 0, acknowledged: 0 } };
  cloud.factory = async mission => ({
    start: async () => { cloud.starts++; return { runId: mission.missionId, cloudGeneration: 1 }; },
    observe: async () => structuredClone(cloud.news),
    workerSession: async (m, session) => { cloud.sessions.push(session);
      return { missionId: m.missionId, messages: [], ...(cloud.authorized ? { authorizedDeadlineAt: cloud.authorized } : {}), ...(cloud.tokenLimit ? { tokenLimit: cloud.tokenLimit } : {}) }; },
    phase: async () => {}, reportStatus: async () => {},
  });
  return cloud;
}

async function setup(t, turns) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mlswarm-restart-waiting-')));
  const fixtures = await makeMixedNativeFixtures(root, [['garden', 'claude']], label => turns(label, root));
  const binding = fixtures.bindings[0], cloud = fakeCloud();
  let store, controllers;
  const open = async () => {
    store = await openRuntimeStore({ directory: join(root, 'ledger') });
    controllers = createRuntimeControllers({ store, adapterFactory: await createNativeAdapterFactory(fixtures), cloudFactory: cloud.factory, observeIntervalMs: 20,
      stopOrphanedMission: mission => stopOrphanedMission(mission, { folder: binding.folder, registryRoot: fixtures.registryRoot }) });
  };
  await open();
  t.after(async () => { await controllers.close(); await store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, binding, cloud, registryRoot: fixtures.registryRoot,
    // A connector service stop and start: the controllers and the ledger close, then a new service opens them.
    // whileDown runs between the two, as an owner's change on the server while the computer is off.
    async restart(whileDown = () => {}) { await controllers.close(); await store.close(); cloud.sessions.length = 0; whileDown(); await open(); },
    accept: input => controllers.accept(input), read: mission => controllers.getMission(query(mission)),
    reports: async mission => (await store.listReports(query(mission))).reports,
    turns: async () => (await nativeEvents(fixtures.events)).filter(event => event.type === 'turn'),
    start: deadlineAt => ({ version: 2, operationId: randomUUID(), kind: 'start', target: binding.target, missionId: randomUUID(),
      payload: { scope: 'Synthetic restart acceptance only.', deadlineAt, execution: { provider: 'claude', model: null } } }),
  };
}

test('a worker waiting past its end time is still waiting after a connector restart and continues in the same mission when time is added', { timeout: 45000 }, async t => {
  const f = await setup(t, () => [{}, {}]);
  const { mission } = await f.accept(f.start(Date.now() + 1500));
  await until(() => f.read(mission), m => m.state === 'waiting' && m.outcomes.length === 1, 'first turn finished');
  await until(async () => Date.now(), now => now > mission.deadlineAt + 50, 'end time passed');
  assert.equal((await f.read(mission)).state, 'waiting');

  await f.restart();
  const restored = await f.read(mission);
  assert.equal(restored.state, 'waiting', 'not ended, failed or recovery_required');
  assert.equal(restored.deadlineAt, mission.deadlineAt);
  await until(async () => f.cloud.sessions, sessions => sessions.some(s => s.missionId === mission.missionId && s.phase === 'waiting'), 'the restored worker reconnects');
  await sleep(150);
  assert.equal((await f.turns()).length, 1, 'no turn starts while the time is up');
  assert.equal((await f.reports(mission)).filter(report => report.kind === 'stop_run').length, 0, 'the run was not ended');

  // The owner adds time: the waiting worker continues without being started again.
  f.cloud.authorized = Date.now() + 60000;
  const turns = await until(() => f.turns(), events => events.length === 2, 'second turn after time was added');
  assert.equal(turns[1].sessionId, turns[0].sessionId, 'the same native session continues');
  const after = await until(() => f.read(mission), m => m.state === 'waiting' && m.outcomes.length === 2, 'second turn finished');
  assert.equal(after.deadlineAt, f.cloud.authorized); assert.equal(after.missionId, mission.missionId);
});

test('a worker waiting at its token cap is still waiting after a connector restart and continues in the same mission when the cap is raised', { timeout: 45000 }, async t => {
  // Each synthetic Claude turn reports 10 input + 3 output tokens.
  const f = await setup(t, () => [{ result: 'Synthetic turn that has more to do.\nWORK_NEXT: runnable' }, {}]);
  f.cloud.tokenLimit = { tokens: 10, othersUsed: 0 };
  const { mission } = await f.accept(f.start(Date.now() + 45000));
  await until(() => f.read(mission), m => m.state === 'waiting' && m.outcomes.length === 1, 'the turn that crossed the cap finished');
  await until(async () => f.cloud.sessions, sessions => sessions.some(s => s.tokens?.counted === 13 && s.phase === 'waiting'), 'the computer reports the tokens it counted');
  await sleep(150);
  assert.equal((await f.turns()).length, 1, 'no turn starts at the cap, although the worker had more to do');

  await f.restart();
  assert.equal((await f.read(mission)).state, 'waiting');
  await until(async () => f.cloud.sessions, sessions => sessions.some(s => s.missionId === mission.missionId && s.phase === 'waiting' && s.tokens?.counted === 13), 'the restored worker reconnects with its count');
  await sleep(150);
  assert.equal((await f.turns()).length, 1, 'still at the cap after the restart');
  assert.equal((await f.reports(mission)).filter(report => report.kind === 'stop_run').length, 0, 'the run was not ended');

  f.cloud.tokenLimit = { tokens: 1000, othersUsed: 0 };
  const turns = await until(() => f.turns(), events => events.length === 2, 'second turn after the cap was raised');
  assert.equal(turns[1].sessionId, turns[0].sessionId, 'the same native session continues');
});

for (const [label, raised] of [['raised', { tokens: 1000, othersUsed: 0 }], ['removed', null]])
  test(`a worker waiting at its token cap continues after a connector restart when the cap was ${label} while the connector was down`, { timeout: 45000 }, async t => {
    const f = await setup(t, () => [{ result: 'Synthetic turn that has more to do.\nWORK_NEXT: runnable' }, {}]);
    f.cloud.tokenLimit = { tokens: 10, othersUsed: 0 };
    const { mission } = await f.accept(f.start(Date.now() + 45000));
    await until(() => f.read(mission), m => m.state === 'waiting' && m.outcomes.length === 1, 'the turn that crossed the cap finished');
    await until(async () => f.cloud.sessions, sessions => sessions.some(s => s.tokens?.counted === 13 && s.phase === 'waiting'), 'waiting at the cap');

    await f.restart(() => { f.cloud.tokenLimit = raised; });
    const turns = await until(() => f.turns(), events => events.length === 2, 'the restored worker runs its next turn with no other trigger');
    assert.equal(turns[1].sessionId, turns[0].sessionId, 'the same native session continues');
  });

test('a worker restored at its token cap stays waiting while the first reply after the restart still shows the cap reached', { timeout: 45000 }, async t => {
  const f = await setup(t, () => [{ result: 'Synthetic turn that has more to do.\nWORK_NEXT: runnable' }, {}]);
  f.cloud.tokenLimit = { tokens: 10, othersUsed: 0 };
  const { mission } = await f.accept(f.start(Date.now() + 45000));
  await until(() => f.read(mission), m => m.state === 'waiting' && m.outcomes.length === 1, 'the turn that crossed the cap finished');
  // Raised while the computer was off, but the pool's other missions used the rest.
  await f.restart(() => { f.cloud.tokenLimit = { tokens: 100, othersUsed: 90 }; });
  await until(async () => f.cloud.sessions, sessions => sessions.filter(s => s.missionId === mission.missionId && s.phase === 'waiting').length >= 3, 'several replies after the restart');
  await sleep(150);
  assert.equal((await f.turns()).length, 1, 'no turn while the cap is still reached');
});

test('a paused worker is still paused after a connector restart and Resume continues it in the same mission', { timeout: 45000 }, async t => {
  const f = await setup(t, (label, root) => [{ gate: join(root, `${label}-first`) }, {}]);
  const { mission } = await f.accept(f.start(Date.now() + 45000));
  await until(() => f.read(mission), m => m.currentTurnId, 'first turn running');
  const pause = command(mission, 'pause'); await f.accept(pause);
  await until(() => f.read(mission), m => m.state === 'pausing', 'pausing while the turn finishes');
  await writeFile(join(f.root, 'garden-claude-first'), 'go');
  await until(() => f.read(mission), m => m.state === 'paused', 'paused once the turn ended');

  await f.restart();
  const restored = await f.read(mission);
  assert.equal(restored.state, 'paused'); assert.equal(restored.pauseOperationId, pause.operationId);
  assert.equal(restored.deadlineAt, mission.deadlineAt);
  await until(async () => f.cloud.sessions, sessions => sessions.some(s => s.missionId === mission.missionId && s.phase === 'paused'), 'the restored worker reports paused');
  await sleep(150);
  assert.equal((await f.turns()).length, 1, 'a paused worker starts no turn');

  // As without a restart, the resumed worker runs a turn for news (here a project change), not just because it resumed.
  f.cloud.news.project.revision = 2;
  await f.accept(command(mission, 'resume', { pauseOperationId: pause.operationId }));
  const turns = await until(() => f.turns(), events => events.length === 2, 'resumed turn');
  assert.equal(turns[1].sessionId, turns[0].sessionId, 'the same native session continues');
  await until(() => f.read(mission), m => m.state === 'waiting' && m.outcomes.length === 2, 'resumed turn finished');
  assert.equal((await f.reports(mission)).filter(report => report.kind === 'stop_run').length, 0);
});

test('a waiting worker restored with time added after its start keeps the 24-hour rule measured from now', { timeout: 45000 }, async t => {
  const f = await setup(t, () => [{}, {}]);
  const { mission } = await f.accept(f.start(Date.now() + 1500));
  await until(() => f.read(mission), m => m.state === 'waiting' && m.outcomes.length === 1, 'first turn finished');
  // Time added later can end more than 24 hours after the mission was created, but never more than 24 hours from now.
  await until(async () => Date.now(), now => now > mission.createdAt + 1200, 'some time passed');
  f.cloud.authorized = mission.createdAt + 24 * 60 * 60000 + 500;
  await until(() => f.read(mission), m => m.deadlineAt === f.cloud.authorized && m.state === 'waiting' && m.outcomes.length === 2, 'time added and the next turn finished');
  await f.restart();
  await until(async () => f.cloud.sessions, sessions => sessions.some(s => s.missionId === mission.missionId), 'the restored cloud worker is accepted');
  assert.equal((await f.read(mission)).state, 'waiting');
});

test('a cloud worker whose end time is more than 24 hours from now, beyond clock skew, does not start', { timeout: 20000 }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mlswarm-restart-window-')));
  const store = await openRuntimeStore({ directory: join(root, 'ledger') }), cloud = fakeCloud();
  // This computer's clock runs behind: the same end time is further away by its clock.
  let lag = 120000;
  const controllers = createRuntimeControllers({ store, observeIntervalMs: 20, cloudFactory: cloud.factory, now: () => Date.now() - lag,
    adapterFactory: async () => ({ observe: async () => null, release: async () => {},
      run: async () => ({ delivery: 'not_submitted', failed: false, interrupted: false, retryable: false, cleanupConfirmed: true, text: '' }) }) });
  t.after(async () => { await controllers.close(); await store.close(); rmSync(root, { recursive: true, force: true }); });
  const target = { site: 'https://synthetic.example', ownerId: 'synthetic-owner', projectId: 'garden', agentId: 'claude' };
  const { mission } = await controllers.accept({ version: 2, operationId: randomUUID(), kind: 'start', target, missionId: randomUUID(),
    payload: { scope: 'Synthetic window check.', deadlineAt: Date.now() + 24 * 60 * 60000 - 1000, execution: { provider: 'claude', model: null } } });
  await sleep(200);
  assert.equal(cloud.starts, 0, 'no cloud run starts more than 24 hours and 30 seconds before its end');
  assert.equal((await controllers.getMission(query(mission))).state, 'accepted');
  lag = 20000;
  await until(async () => cloud.starts, starts => starts > 0, 'within the 30-second skew allowance the run starts');
});

const claims = registryRoot => readdirSync(registryRoot).filter(name => name.startsWith('claim-'));
test('a waiting worker survives a connector crash: its leftover processes and dead claim are cleaned up before it continues', { timeout: 30000, skip: !['darwin', 'linux'].includes(process.platform) }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mlswarm-restart-crash-'))), directory = join(root, 'ledger');
  let child, serverPid, store, controllers;
  try {
    const missionId = randomUUID();
    child = fork(new URL('./fixtures/native-binding-leftover-crash.mjs', import.meta.url), [JSON.stringify({ root, missionId })],
      { env: { PATH: '/usr/bin:/bin', HOME: root }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let stderr = ''; child.stderr.on('data', value => { stderr += value; });
    const [data] = await Promise.race([once(child, 'message'), once(child, 'exit').then(code => assert.fail(`Synthetic service exited ${code}: ${stderr}`))]);
    serverPid = data.serverPid;
    const target = data.mission.target, ref = { missionId, generation: 1 };
    // The ledger the crashed connector left: a finished turn, cleanup confirmed, the worker waiting past its end time.
    store = await openRuntimeStore({ directory });
    const { mission } = await store.accept({ version: 2, operationId: randomUUID(), kind: 'start', missionId, target,
      payload: { scope: 'Synthetic waiting worker, never execute a model.', deadlineAt: Date.now() + 500, execution: { provider: 'claude', model: null } } });
    const turnId = randomUUID(); await store.prepareTurn({ ...ref, turnId });
    await store.recordTurn({ ...ref, turnId, text: 'Synthetic.\nWORK_NEXT: waiting', startedAt: Date.now(), endedAt: Date.now(),
      outcome: { delivery: 'acknowledged', failed: false, interrupted: false, retryable: false, cleanupConfirmed: true } });
    await store.close(); store = undefined;
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    assert.equal(alive(serverPid), true, 'the detached mission server outlives the connector');
    assert.equal(claims(data.registryRoot).length, 1, 'the dead connector left its claim');
    await until(async () => Date.now(), now => now > mission.deadlineAt + 50, 'end time passed');

    store = await openRuntimeStore({ directory });
    assert.equal((await store.getMission({ missionId, target })).state, 'waiting');
    const cloud = fakeCloud(), runs = [], seen = [];
    controllers = createRuntimeControllers({ store, observeIntervalMs: 20, cloudFactory: cloud.factory,
      stopOrphanedMission: orphan => stopOrphanedMission(orphan, { folder: data.binding.folder, registryRoot: data.registryRoot }),
      adapterFactory: async () => { seen.push({ server: alive(serverPid), claims: claims(data.registryRoot).length });
        return { observe: async () => null, release: async () => {},
          run: async options => { runs.push(options.prompt); return { delivery: 'acknowledged', failed: false, interrupted: false, retryable: false, cleanupConfirmed: true, text: 'Synthetic.\nWORK_NEXT: waiting' }; } }; } });
    await until(async () => seen, value => value.length === 1, 'the restored worker prepares to continue');
    assert.deepEqual(seen[0], { server: false, claims: 0 }, 'leftover processes and the dead claim are gone first');
    await sleep(150);
    assert.equal(runs.length, 0); assert.equal((await store.getMission({ missionId, target })).state, 'waiting');
    cloud.authorized = Date.now() + 60000;
    await until(async () => runs, value => value.length === 1, 'continues once time is added');
    const after = await until(() => store.getMission({ missionId, target }), m => m.outcomes.length === 2 && m.state === 'waiting', 'turn recorded');
    assert.equal(after.deadlineAt, cloud.authorized);
  } finally {
    await controllers?.close(); await store?.close();
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (serverPid) try { process.kill(serverPid, 'SIGKILL'); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});

// A synthetic adapter and an in-process connector restart; `orphanStop` stands in for ending the dead service's leftovers.
async function fakeService(t, { lag = 0, orphanStop = async () => {}, turn = async () => {}, text = () => 'Synthetic.\nWORK_NEXT: waiting' } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mlswarm-restart-fake-'))), cloud = fakeCloud(), runs = [], orphanStops = [];
  cloud.news.work = { runnable: true, revision: 1 };
  const adapterFactory = async () => ({ observe: async () => null, release: async () => {},
    run: async options => { runs.push(options.prompt); await turn(runs.length); return { delivery: 'acknowledged', failed: false, interrupted: false, retryable: false, cleanupConfirmed: true, text: text(runs.length) }; } });
  let store, controllers;
  const open = async () => {
    store = await openRuntimeStore({ directory: join(root, 'ledger') });
    controllers = createRuntimeControllers({ store, adapterFactory, cloudFactory: cloud.factory, observeIntervalMs: 20, now: () => Date.now() - lag,
      stopOrphanedMission: async mission => { orphanStops.push(mission.missionId); await orphanStop(mission); } });
  };
  await open();
  t.after(async () => { await controllers.close(); await store.close(); rmSync(root, { recursive: true, force: true }); });
  const target = { site: 'https://synthetic.example', ownerId: 'synthetic-owner', projectId: 'garden', agentId: 'claude' };
  return { cloud, runs, orphanStops,
    async restart() { await controllers.close(); await store.close(); await open(); },
    accept: input => controllers.accept(input), read: mission => controllers.getMission(query(mission)),
    start: deadlineAt => ({ version: 2, operationId: randomUUID(), kind: 'start', target, missionId: randomUUID(),
      payload: { scope: 'Synthetic restart acceptance only.', deadlineAt, execution: { provider: 'claude', model: null } } }) };
}

test('a restored waiting worker with time left and no news runs no turn after a connector restart', { timeout: 20000 }, async t => {
  const f = await fakeService(t);
  const { mission } = await f.accept(f.start(Date.now() + 60000));
  await until(() => f.read(mission), m => m.state === 'waiting' && m.outcomes.length === 1, 'first turn finished');
  await f.restart();
  await until(async () => f.orphanStops, stops => stops.length === 1, 'leftovers ended at restart');
  await sleep(300);
  assert.equal(f.runs.length, 1, 'nothing changed while the connector was down');
  assert.equal((await f.read(mission)).state, 'waiting');
});

test('a restored waiting worker runs a turn for news that arrived while the connector was down', { timeout: 20000 }, async t => {
  for (const change of [news => { news.project.revision = 2; }, news => { news.work.revision = 2; }]) {
    const f = await fakeService(t);
    const { mission } = await f.accept(f.start(Date.now() + 60000));
    await until(() => f.read(mission), m => m.state === 'waiting' && m.outcomes.length === 1, 'first turn finished');
    await f.restart();
    change(f.cloud.news);
    await until(async () => f.runs, runs => runs.length === 2, 'a turn for the news');
    await until(() => f.read(mission), m => m.state === 'waiting' && m.outcomes.length === 2, 'turn recorded');
  }
});

test('a worker restored paused ends the dead service leftovers at restart and stays paused', { timeout: 20000 }, async t => {
  const f = await fakeService(t);
  const { mission } = await f.accept(f.start(Date.now() + 60000));
  await until(() => f.read(mission), m => m.state === 'waiting' && m.outcomes.length === 1, 'first turn finished');
  await f.accept(command(mission, 'pause'));
  await until(() => f.read(mission), m => m.state === 'paused', 'paused');
  await f.restart();
  await until(async () => f.orphanStops, stops => stops.length === 1, 'leftovers ended before waiting');
  await sleep(200);
  assert.equal((await f.read(mission)).state, 'paused'); assert.equal(f.runs.length, 1);
});

test('a worker restored paused whose leftovers cannot be confirmed ended needs recovery', { timeout: 20000 }, async t => {
  let refuse = false;
  const f = await fakeService(t, { orphanStop: async () => { if (refuse) throw new Error('Synthetic: cannot confirm.'); } });
  const { mission } = await f.accept(f.start(Date.now() + 60000));
  await until(() => f.read(mission), m => m.state === 'waiting' && m.outcomes.length === 1, 'first turn finished');
  await f.accept(command(mission, 'pause'));
  await until(() => f.read(mission), m => m.state === 'paused', 'paused');
  refuse = true; await f.restart();
  await until(() => f.read(mission), m => m.state === 'recovery_required', 'recovery required');
  assert.equal(f.runs.length, 1);
});

test('time added up to 24 hours and 30 seconds away by this computer\'s clock is accepted', { timeout: 20000 }, async t => {
  // This computer's clock runs 20 seconds behind the server's.
  const f = await fakeService(t, { lag: 20000 });
  const { mission } = await f.accept(f.start(Date.now() + 1500));
  await until(() => f.read(mission), m => m.state === 'waiting' && m.outcomes.length === 1, 'first turn finished');
  f.cloud.authorized = Date.now() + 24 * 60 * 60000 - 5000;
  await until(() => f.read(mission), m => m.deadlineAt === f.cloud.authorized, 'the added time is applied');
});

test('Kill of a restored waiting worker ends it and frees the checkout', { timeout: 45000 }, async t => {
  const f = await setup(t, () => [{}, {}]);
  const { mission } = await f.accept(f.start(Date.now() + 1500));
  await until(() => f.read(mission), m => m.state === 'waiting' && m.outcomes.length === 1, 'first turn finished');
  await f.restart();
  await until(async () => f.cloud.sessions, sessions => sessions.some(s => s.missionId === mission.missionId), 'the restored worker reconnects');
  await f.accept(command(mission, 'stop'));
  await until(() => f.read(mission), m => m.state === 'stopped', 'stopped');
  assert.equal(claims(f.registryRoot).length, 0, 'the checkout claim is freed');
  assert.equal((await f.turns()).length, 1);
});

// The worker's own "more to do" (WORK_NEXT: runnable) survives a connector restart.
const moreFirst = n => n === 1 ? 'Synthetic.\nWORK_NEXT: runnable' : 'Synthetic.\nWORK_NEXT: waiting';
test('a worker with more to do whose end time passed continues after a restart once time is added', { timeout: 20000 }, async t => {
  let deadlineAt;
  const f = await fakeService(t, { text: moreFirst, turn: async n => { if (n === 1) while (Date.now() <= deadlineAt + 50) await sleep(10); } });
  deadlineAt = Date.now() + 1000;
  const { mission } = await f.accept(f.start(deadlineAt));
  const waiting = await until(() => f.read(mission), m => m.state === 'waiting' && m.outcomes.length === 1, 'first turn finished past the end time');
  assert.equal(waiting.outcomes[0].outcome.seen.more, true);
  await f.restart();
  await sleep(200);
  assert.equal(f.runs.length, 1, 'no turn while the time is up');
  f.cloud.authorized = Date.now() + 60000;
  await until(async () => f.runs, runs => runs.length === 2, 'continues once time is added');
});

test('a paused worker with more to do continues when resumed after a restart', { timeout: 20000 }, async t => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const f = await fakeService(t, { text: moreFirst, turn: async n => { if (n === 1) await gate; } });
  const { mission } = await f.accept(f.start(Date.now() + 60000));
  await until(() => f.read(mission), m => m.currentTurnId, 'first turn running');
  const pause = command(mission, 'pause'); await f.accept(pause);
  release();
  await until(() => f.read(mission), m => m.state === 'paused' && m.outcomes.length === 1, 'paused once the turn ended');
  await f.restart();
  await sleep(200);
  assert.equal(f.runs.length, 1, 'a paused worker starts no turn');
  await f.accept(command(mission, 'resume', { pauseOperationId: pause.operationId }));
  await until(async () => f.runs, runs => runs.length === 2, 'the unfinished work continues without news');
});
