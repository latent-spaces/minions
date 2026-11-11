// A provider usage or rate limit is a wait, not a failure (owner, 10 November 2026). In-memory adapters only: no native
// executable or model is resolved. The adapter's outcomes have the shape modelTurnOutcome returns.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openRuntimeStore } from '../src/service/store.mjs';
import { createRuntimeControllers } from '../src/service/controllers.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const ok = () => ({ text: 'WORK_NEXT: waiting', delivery: 'acknowledged', failed: false, interrupted: false, retryable: false, cleanupConfirmed: true });
const failed = (failureCode, extra = {}) => ({ text: '', delivery: 'acknowledged', failed: true, interrupted: false, retryable: true, cleanupConfirmed: true, failureCode, ...extra });
const limited = resetAt => failed('provider_limited', resetAt === undefined ? {} : { limitResetAt: resetAt });
async function until(read, predicate, label, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { const value = await read(); if (predicate(value)) return value; await sleep(10); }
  assert.fail(`Timed out: ${label}`);
}

// `clock` is the controllers' time; tests move it forward to pass a wait without sleeping through it.
async function setup(t, run, { directory } = {}) {
  directory ??= await mkdtemp(join(tmpdir(), 'mlswarm-provider-limits-'));
  const ctx = { directory, sessions: [], runs: new Map(), offset: 0, missions: [] };
  ctx.now = () => Date.now() + ctx.offset;
  const store = await openRuntimeStore({ directory });
  const news = { project: { started: true, paused: false, closed: false }, pending: 0, acknowledged: 0 };
  const cloud = {
    async start(mission) { return { runId: mission.missionId, cloudGeneration: 1, pollSeconds: 20 }; },
    async observe() { return news; },
    async workerSession(mission, session) { ctx.sessions.push({ agentId: mission.target.agentId, ...structuredClone(session) }); return { missionId: mission.missionId, messages: [], tokenLimit: null }; },
    async phase() {}, async reportStatus() {},
  };
  const controllers = createRuntimeControllers({ store, cloudFactory: () => cloud, now: ctx.now, observeIntervalMs: 15, onChangeSpreadMs: 0,
    // A restored worker first ends what the old service left; these in-memory turns leave nothing.
    stopOrphanedMission: async () => {},
    adapterFactory: async mission => ({
      async observe() { assert.fail('cloud observations only'); },
      async run(args) {
        const agent = mission.target.agentId, turn = (ctx.runs.get(agent) ?? 0) + 1; ctx.runs.set(agent, turn); ctx.lastRunAt = Date.now();
        await args.onPromptSubmitted(); await args.onTurnStarted();
        return run(agent, turn, args);
      },
      async release() {},
    }) });
  ctx.controllers = controllers; ctx.store = store;
  ctx.close = async () => { await controllers.close(); await store.close(); };
  t.after(async () => { if (!ctx.closed) await ctx.close(); await rm(directory, { recursive: true, force: true }); });
  ctx.start = async agentId => {
    const target = { site: 'https://fixture.invalid', ownerId: 'synthetic-owner', projectId: 'synthetic-project', agentId };
    const mission = (await controllers.accept({ version: 2, operationId: randomUUID(), missionId: randomUUID(), kind: 'start', target,
      payload: { scope: 'Synthetic provider limit acceptance', deadlineAt: ctx.now() + 20 * 3_600_000, execution: { provider: 'claude', model: null } } })).mission;
    ctx.missions.push(mission); return mission;
  };
  ctx.inspect = mission => store.getMission({ missionId: mission.missionId, target: mission.target });
  return ctx;
}

test('six workers that hit a provider limit wait and try again instead of ending; none counts toward the failure limit', async t => {
  // Four limited turns each, then work: more than the three failures that would end a worker.
  const ctx = await setup(t, (_agent, turn) => turn > 4 ? ok() : limited(Date.now() + 40));
  const agents = Array.from({ length: 6 }, (_, i) => `synthetic-agent-${i}`);
  for (const agent of agents) await ctx.start(agent);
  await until(() => agents.every(agent => (ctx.runs.get(agent) ?? 0) >= 5), done => done, 'every worker reaches a working turn after four limits', 20000);
  for (const mission of ctx.missions) {
    const saved = await until(() => ctx.inspect(mission), m => m.outcomes.length >= 5, 'fifth turn saved');
    assert.equal(saved.state, 'waiting', `${mission.target.agentId} keeps working`);
    assert.deepEqual(saved.outcomes.slice(0, 5).map(item => item.outcome.failureCode ?? 'ok'), ['provider_limited', 'provider_limited', 'provider_limited', 'provider_limited', 'ok']);
  }
});

test('a limit with no reset time is reported without a time and is cleared by the next working turn', async t => {
  const ctx = await setup(t, (_agent, turn) => turn === 1 ? limited() : ok());
  const mission = await ctx.start('synthetic-agent');
  await until(() => ctx.sessions.at(-1), s => s?.providerLimit, 'the worker says it is held');
  assert.deepEqual(ctx.sessions.at(-1).providerLimit, { retryAt: null });
  assert.equal(ctx.sessions.at(-1).phase, 'waiting');
  // The growing wait starts at 10 s (0.8 to 1.2 with jitter): the worker retries by itself, then is no longer held.
  await until(() => ctx.runs.get('synthetic-agent') ?? 0, n => n === 2, 'retried after the wait', 20000);
  await until(() => ctx.sessions.at(-1), s => s && !s.providerLimit, 'limit cleared', 25000);
  await until(() => ctx.inspect(mission), m => m.outcomes.length === 2 && m.state === 'waiting', 'the retry turn worked');
});

test('a worker does not retry a provider limit before the reset time, so it never loops', async t => {
  let resetAt;
  const ctx = await setup(t, (_agent, turn) => turn === 1 ? limited(resetAt = Date.now() + 1500) : ok());
  const mission = await ctx.start('synthetic-agent');
  await until(() => ctx.runs.get('synthetic-agent') ?? 0, n => n === 1, 'first turn limited');
  await sleep(1000);
  assert.equal(ctx.runs.get('synthetic-agent'), 1, 'no retry before the reset');
  await until(() => ctx.runs.get('synthetic-agent') ?? 0, n => n === 2, 'retried after the reset');
  assert.ok(ctx.lastRunAt >= resetAt);
  await until(() => ctx.inspect(mission), m => m.outcomes.length === 2 && m.state === 'waiting', 'the retry turn worked');
});

test('other failures still end a worker after three, and provider limits between them do not reset the count', async t => {
  const ctx = await setup(t, (_agent, turn) => turn === 2 ? limited(ctx.now() + 20) : failed('local_execution_failure'));
  const mission = await ctx.start('synthetic-agent');
  const timer = setInterval(() => { ctx.offset += 60_000; }, 30); t.after(() => clearInterval(timer));
  const saved = await until(() => ctx.inspect(mission), m => m.state === 'stopped', 'ended at the failure limit', 15000);
  clearInterval(timer);
  assert.equal(saved.reason, 'failure_limit');
  assert.deepEqual(saved.outcomes.map(item => item.outcome.failureCode), ['local_execution_failure', 'provider_limited', 'local_execution_failure', 'local_execution_failure']);
});

test('Kill during a provider limit wait ends the worker at once', async t => {
  const ctx = await setup(t, () => limited(Date.now() + 60 * 60_000));
  const mission = await ctx.start('synthetic-agent');
  await until(() => ctx.inspect(mission), m => m.outcomes.length === 1 && m.state === 'waiting', 'waiting for the reset');
  await ctx.controllers.accept({ version: 2, operationId: randomUUID(), kind: 'stop', target: mission.target, missionId: mission.missionId, generation: mission.generation, payload: {} });
  const saved = await until(() => ctx.inspect(mission), m => m.state === 'stopped', 'killed', 5000);
  assert.equal(ctx.runs.get('synthetic-agent'), 1);
  assert.notEqual(saved.reason, 'failure_limit');
});

test('Pause during a provider limit wait holds the worker; after Resume it still waits for the reset', async t => {
  let resetAt;
  const ctx = await setup(t, (_agent, turn) => turn === 1 ? limited(resetAt = Date.now() + 1500) : ok());
  const mission = await ctx.start('synthetic-agent');
  await until(() => ctx.inspect(mission), m => m.outcomes.length === 1 && m.state === 'waiting', 'waiting for the reset');
  const command = (kind, payload = {}) => ctx.controllers.accept({ version: 2, operationId: randomUUID(), kind, target: mission.target, missionId: mission.missionId, generation: mission.generation, payload });
  const pauseId = randomUUID();
  await ctx.controllers.accept({ version: 2, operationId: pauseId, kind: 'pause', target: mission.target, missionId: mission.missionId, generation: mission.generation, payload: {} });
  await until(() => ctx.inspect(mission), m => m.state === 'paused', 'paused');
  await command('resume', { pauseOperationId: pauseId });
  await until(() => ctx.inspect(mission), m => m.state === 'waiting', 'resumed');
  assert.equal(ctx.runs.get('synthetic-agent'), 1, 'Resume does not skip the reset');
  await until(() => ctx.runs.get('synthetic-agent') ?? 0, n => n === 2, 'retried after the reset');
  assert.ok(ctx.lastRunAt >= resetAt, 'not before the reset time');
});

test('a provider limit wait survives a connector restart', async t => {
  let resetAt;
  const first = await setup(t, () => limited(resetAt = Date.now() + 1500));
  const mission = await first.start('synthetic-agent');
  await until(() => first.inspect(mission), m => m.outcomes.length === 1 && m.state === 'waiting', 'waiting for the reset');
  await first.close(); first.closed = true;
  const second = await setup(t, () => ok(), { directory: first.directory });
  await until(() => second.sessions.length, n => n > 0, 'restored worker reports in');
  assert.equal(second.runs.get('synthetic-agent') ?? 0, 0, 'the restored worker still waits for the reset');
  assert.equal(second.sessions[0].providerLimit?.retryAt, resetAt, 'and says when it tries again');
  await until(() => second.runs.get('synthetic-agent') ?? 0, n => n === 1, 'retried after the reset');
  assert.ok(second.lastRunAt >= resetAt, 'not before the reset time');
  await until(() => second.inspect(mission), m => m.outcomes.length === 2 && m.state === 'waiting', 'the retry turn worked');
});
