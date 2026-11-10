// Real durable store/controller with in-memory provider protocol, no model processes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openRuntimeStore } from '../src/service/store.mjs';
import { createRuntimeControllers } from '../src/service/controllers.mjs';

const target = { site: 'https://fixture.invalid', ownerId: 'owner', projectId: 'project', agentId: 'agent' };
const start = () => ({ version: 2, operationId: randomUUID(), kind: 'start', target, missionId: randomUUID(),
  payload: { scope: 'Synthetic cleanup only', deadlineAt: Date.now() + 60000, execution: { provider: 'codex', model: null } } });
const stop = mission => ({ version: 2, operationId: randomUUID(), kind: 'stop', target, missionId: mission.missionId, generation: mission.generation, payload: {} });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
async function until(read, predicate) {
  const end = Date.now() + 5000;
  while (Date.now() < end) { const value = await read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail('Cleanup state did not reach the expected durable boundary.');
}
async function setup(t, release) {
  const directory = await mkdtemp(join(tmpdir(), 'mlswarm-controller-cleanup-'));
  const ctx = { directory, store: await openRuntimeStore({ directory }), turns: 0, releases: 0 };
  const cloud = {
    start: async mission => ({ runId: mission.missionId, cloudGeneration: 1 }),
    observe: async () => ({ project: { started: true, paused: false, closed: false }, pending: 0, acknowledged: 0 }),
    workerSession: async mission => ({ missionId: mission.missionId, authorizedDeadlineAt: mission.deadlineAt, messages: [] }),
    phase: async () => {},
  };
  ctx.controllers = createRuntimeControllers({ store: ctx.store, observeIntervalMs: 10, cloudFactory: () => cloud,
    adapterFactory: async () => ({
      run: async options => {
        ctx.turns++; await options.onPromptSubmitted(); await options.onTurnStarted();
        return { delivery: 'acknowledged', text: 'WORK_NEXT: waiting', failed: false, interrupted: false, retryable: false, cleanupConfirmed: true };
      },
      release: async () => { ctx.releases++; await release(ctx); },
    }) });
  t.after(async () => { await ctx.controllers.close(); await ctx.store.close(); await rm(directory, { recursive: true, force: true }); });
  ctx.mission = (await ctx.controllers.accept(start())).mission;
  ctx.inspect = () => ctx.store.getMission({ target, missionId: ctx.mission.missionId });
  await until(ctx.inspect, mission => mission.outcomes.length === 1);
  ctx.reports = async () => (await ctx.store.listReports({ missionId: ctx.mission.missionId })).reports;
  return ctx;
}

test('terminal state and stop report wait for detached-process cleanup confirmation', async t => {
  const gate = deferred(); t.after(() => gate.resolve());
  const ctx = await setup(t, () => gate.promise);
  await ctx.controllers.accept(stop(ctx.mission));
  await until(ctx.inspect, mission => mission.reason === 'mission_cleanup_pending');
  assert.equal((await ctx.inspect()).state, 'recovery_required');
  assert.equal((await ctx.reports()).filter(report => report.kind === 'stop_run').length, 0);
  await assert.rejects(ctx.controllers.accept(start()), /active|recovery|mission/i);
  gate.resolve();
  await until(ctx.inspect, mission => mission.state === 'stopped');
  assert.equal((await ctx.reports()).filter(report => report.kind === 'stop_run').length, 1);
  assert.equal(ctx.turns, 1);
});

test('cleanup refusal retains recovery, exact Stop retries cleanup, and publishes one stop report', async t => {
  let blocked = true;
  const ctx = await setup(t, () => { if (blocked) throw new Error('Synthetic cleanup uncertainty'); });
  const command = stop(ctx.mission);
  await ctx.controllers.accept(command);
  await until(ctx.inspect, mission => mission.reason === 'mission_cleanup_uncertain');
  assert.equal((await ctx.inspect()).state, 'recovery_required');
  assert.equal((await ctx.reports()).filter(report => report.kind === 'stop_run').length, 0);
  assert.equal(ctx.releases, 1);
  blocked = false;
  assert.equal((await ctx.controllers.accept(command)).created, false);
  await until(ctx.inspect, mission => mission.state === 'stopped');
  assert.equal(ctx.releases, 2);
  assert.equal(ctx.turns, 1, 'retry cleanup never requests another provider turn');
  assert.equal((await ctx.reports()).filter(report => report.kind === 'stop_run').length, 1);
});

test('after a restart, Stop becomes a terminal receipt only once the orphaned mission is confirmed killed', async t => {
  const ctx = await setup(t, () => { throw new Error('Synthetic cleanup uncertainty'); });
  await ctx.controllers.accept(stop(ctx.mission));
  await until(ctx.inspect, mission => mission.reason === 'mission_cleanup_uncertain');
  await ctx.controllers.close(); await ctx.store.close();
  ctx.store = await openRuntimeStore({ directory: ctx.directory });
  let clean = false, factoryCalls = 0; const kills = [];
  ctx.controllers = createRuntimeControllers({ store: ctx.store,
    adapterFactory: async () => { factoryCalls++; throw new Error('No restarted provider allowed.'); },
    stopOrphanedMission: async mission => { kills.push(mission.missionId); if (!clean) throw new Error('Synthetic kill uncertainty'); } });
  await ctx.controllers.accept(stop(ctx.mission));
  assert.equal((await ctx.inspect()).state, 'recovery_required');
  assert.equal((await ctx.reports()).filter(report => report.kind === 'stop_run').length, 0);
  clean = true;
  await ctx.controllers.accept(stop(ctx.mission));
  assert.equal((await ctx.inspect()).state, 'stopped');
  assert.equal((await ctx.reports()).filter(report => report.kind === 'stop_run').length, 1);
  assert.equal(factoryCalls, 0);
  assert.deepEqual(kills, [ctx.mission.missionId, ctx.mission.missionId]);
  await ctx.controllers.accept(stop(ctx.mission));
  assert.equal(kills.length, 2, 'a settled mission is never swept again');
});
