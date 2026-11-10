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
// The fake cloud answers every session sync with the job's token cap. A job has no time limit.
function fakeCloud() {
  const cloud = { sessions: [], starts: 0, news: { project: { started: true, paused: false, closed: false }, pending: 0, acknowledged: 0 } };
  cloud.factory = async mission => ({
    start: async () => { cloud.starts++; return { runId: mission.missionId, cloudGeneration: 1 }; },
    observe: async () => structuredClone(cloud.news),
    workerSession: async (m, session) => { cloud.sessions.push(session);
      return { missionId: m.missionId, messages: [], ...(cloud.tokenLimit ? { tokenLimit: cloud.tokenLimit } : {}) }; },
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
    // oldDeadlineAt imitates a start saved before 10 November 2026, when a job had an end time.
    start: oldDeadlineAt => ({ version: 2, operationId: randomUUID(), kind: 'start', target: binding.target, missionId: randomUUID(),
      payload: { scope: 'Synthetic restart acceptance only.', ...(oldDeadlineAt === undefined ? {} : { deadlineAt: oldDeadlineAt }), execution: { provider: 'claude', model: null } } }),
  };
}

test('a worker whose stored end time passed is not held after a connector restart: news runs its next turn in the same mission', { timeout: 45000 }, async t => {
  const f = await setup(t, () => [{}, {}]);
  const oldEnd = Date.now() + 1500;
  const { mission } = await f.accept(f.start(oldEnd));
  await until(() => f.read(mission), m => m.state === 'waiting' && m.outcomes.length === 1, 'first turn finished');
  await until(async () => Date.now(), now => now > oldEnd + 50, 'old end time passed');

  await f.restart();
  const restored = await f.read(mission);
  assert.equal(restored.state, 'waiting', 'not ended, failed or recovery_required');
  assert.equal(Object.hasOwn(restored, 'deadlineAt'), false, 'the old end time is not reported');
  await until(async () => f.cloud.sessions, sessions => sessions.some(s => s.missionId === mission.missionId && s.phase === 'waiting'), 'the restored worker reconnects');
  assert.equal(f.cloud.sessions.some(s => Object.hasOwn(s, 'deadlineAt')), false, 'no end time is sent to the server');

  // News arrives: the worker continues in the same mission and native session; the passed end time does not hold it.
  f.cloud.news.project.revision = 2;
  const turns = await until(() => f.turns(), events => events.length === 2, 'second turn after the old end time');
  assert.equal(turns[1].sessionId, turns[0].sessionId, 'the same native session continues');
  const after = await until(() => f.read(mission), m => m.state === 'waiting' && m.outcomes.length === 2, 'second turn finished');
  assert.equal(after.missionId, mission.missionId);
  assert.equal((await f.reports(mission)).filter(report => report.kind === 'stop_run').length, 0, 'the run was not ended');
});

test('a worker waiting at its token cap is still waiting after a connector restart and continues in the same mission when the cap is raised', { timeout: 45000 }, async t => {
  // Each synthetic Claude turn reports 10 input + 3 output tokens.
  const f = await setup(t, () => [{ result: 'Synthetic turn that has more to do.\nWORK_NEXT: runnable' }, {}]);
  f.cloud.tokenLimit = { tokens: 10, othersUsed: 0 };
  const { mission } = await f.accept(f.start());
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
    const { mission } = await f.accept(f.start());
    await until(() => f.read(mission), m => m.state === 'waiting' && m.outcomes.length === 1, 'the turn that crossed the cap finished');
    await until(async () => f.cloud.sessions, sessions => sessions.some(s => s.tokens?.counted === 13 && s.phase === 'waiting'), 'waiting at the cap');

    await f.restart(() => { f.cloud.tokenLimit = raised; });
    const turns = await until(() => f.turns(), events => events.length === 2, 'the restored worker runs its next turn with no other trigger');
    assert.equal(turns[1].sessionId, turns[0].sessionId, 'the same native session continues');
  });

test('a worker restored at its token cap stays waiting while the first reply after the restart still shows the cap reached', { timeout: 45000 }, async t => {
  const f = await setup(t, () => [{ result: 'Synthetic turn that has more to do.\nWORK_NEXT: runnable' }, {}]);
  f.cloud.tokenLimit = { tokens: 10, othersUsed: 0 };
  const { mission } = await f.accept(f.start());
  await until(() => f.read(mission), m => m.state === 'waiting' && m.outcomes.length === 1, 'the turn that crossed the cap finished');
  // Raised while the computer was off, but the pool's other missions used the rest.
  await f.restart(() => { f.cloud.tokenLimit = { tokens: 100, othersUsed: 90 }; });
  await until(async () => f.cloud.sessions, sessions => sessions.filter(s => s.missionId === mission.missionId && s.phase === 'waiting').length >= 3, 'several replies after the restart');
  await sleep(150);
  assert.equal((await f.turns()).length, 1, 'no turn while the cap is still reached');
});

test('a paused worker is still paused after a connector restart and Resume continues it in the same mission', { timeout: 45000 }, async t => {
  const f = await setup(t, (label, root) => [{ gate: join(root, `${label}-first`) }, {}]);
  const { mission } = await f.accept(f.start());
  await until(() => f.read(mission), m => m.currentTurnId, 'first turn running');
  const pause = command(mission, 'pause'); await f.accept(pause);
  await until(() => f.read(mission), m => m.state === 'pausing', 'pausing while the turn finishes');
  await writeFile(join(f.root, 'garden-claude-first'), 'go');
  await until(() => f.read(mission), m => m.state === 'paused', 'paused once the turn ended');

  await f.restart();
  const restored = await f.read(mission);
  assert.equal(restored.state, 'paused'); assert.equal(restored.pauseOperationId, pause.operationId);
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
    // The ledger the crashed connector left: a finished turn, cleanup confirmed, the worker waiting; its stored end time passes.
    store = await openRuntimeStore({ directory });
    const oldEnd = Date.now() + 500;
    await store.accept({ version: 2, operationId: randomUUID(), kind: 'start', missionId, target,
      payload: { scope: 'Synthetic waiting worker, never execute a model.', deadlineAt: oldEnd, execution: { provider: 'claude', model: null } } });
    const turnId = randomUUID(); await store.prepareTurn({ ...ref, turnId });
    await store.recordTurn({ ...ref, turnId, text: 'Synthetic.\nWORK_NEXT: waiting', startedAt: Date.now(), endedAt: Date.now(),
      outcome: { delivery: 'acknowledged', failed: false, interrupted: false, retryable: false, cleanupConfirmed: true } });
    await store.close(); store = undefined;
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    assert.equal(alive(serverPid), true, 'the detached mission server outlives the connector');
    assert.equal(claims(data.registryRoot).length, 1, 'the dead connector left its claim');
    await until(async () => Date.now(), now => now > oldEnd + 50, 'old end time passed');

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
    // This ledger recorded no observation, so the restored worker takes its first turn; the passed end time holds nothing.
    await until(async () => runs, value => value.length === 1, 'continues after the old end time');
    await until(() => store.getMission({ missionId, target }), m => m.outcomes.length === 2 && m.state === 'waiting', 'turn recorded');
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
    start: oldDeadlineAt => ({ version: 2, operationId: randomUUID(), kind: 'start', target, missionId: randomUUID(),
      payload: { scope: 'Synthetic restart acceptance only.', ...(oldDeadlineAt === undefined ? {} : { deadlineAt: oldDeadlineAt }), execution: { provider: 'claude', model: null } } }) };
}

test('a restored waiting worker with time left and no news runs no turn after a connector restart', { timeout: 20000 }, async t => {
  const f = await fakeService(t);
  const { mission } = await f.accept(f.start());
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
    const { mission } = await f.accept(f.start());
    await until(() => f.read(mission), m => m.state === 'waiting' && m.outcomes.length === 1, 'first turn finished');
    await f.restart();
    change(f.cloud.news);
    await until(async () => f.runs, runs => runs.length === 2, 'a turn for the news');
    await until(() => f.read(mission), m => m.state === 'waiting' && m.outcomes.length === 2, 'turn recorded');
  }
});

test('a worker restored paused ends the dead service leftovers at restart and stays paused', { timeout: 20000 }, async t => {
  const f = await fakeService(t);
  const { mission } = await f.accept(f.start());
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
  const { mission } = await f.accept(f.start());
  await until(() => f.read(mission), m => m.state === 'waiting' && m.outcomes.length === 1, 'first turn finished');
  await f.accept(command(mission, 'pause'));
  await until(() => f.read(mission), m => m.state === 'paused', 'paused');
  refuse = true; await f.restart();
  await until(() => f.read(mission), m => m.state === 'recovery_required', 'recovery required');
  assert.equal(f.runs.length, 1);
});

test('Kill of a restored waiting worker ends it and frees the checkout', { timeout: 45000 }, async t => {
  const f = await setup(t, () => [{}, {}]);
  const { mission } = await f.accept(f.start());
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
test('a worker with more to do whose stored end time passed during its turn continues by itself', { timeout: 20000 }, async t => {
  let oldEnd;
  const f = await fakeService(t, { text: moreFirst, turn: async n => { if (n === 1) while (Date.now() <= oldEnd + 50) await sleep(10); } });
  oldEnd = Date.now() + 1000;
  const { mission } = await f.accept(f.start(oldEnd));
  const after = await until(() => f.read(mission), m => m.outcomes.length === 2, 'the next turn starts past the old end time');
  assert.equal(after.outcomes[0].outcome.seen.more, true);
});

test('a paused worker with more to do continues when resumed after a restart', { timeout: 20000 }, async t => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const f = await fakeService(t, { text: moreFirst, turn: async n => { if (n === 1) await gate; } });
  const { mission } = await f.accept(f.start());
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
