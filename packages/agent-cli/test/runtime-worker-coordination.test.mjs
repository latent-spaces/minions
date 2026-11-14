import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { openRuntimeStore } from '../src/service/store.mjs';
import { createRuntimeControllers } from '../src/service/controllers.mjs';

const target = { site: 'https://synthetic.example', ownerId: 'owner', projectId: 'park', agentId: 'worker' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const success = { text: 'Synthetic completed.\nWORK_NEXT: waiting', delivery: 'acknowledged', failed: false,
  interrupted: false, retryable: false, cleanupConfirmed: true };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(read, predicate, label) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { const value = await read(); if (predicate(value)) return value; await sleep(10); }
  assert.fail(`Timed out: ${label}`);
}
async function setup(t, { retry = async () => {}, run = async () => success, wrapStore = store => store } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'mlswarm-worker-coordination-'));
  const store = await openRuntimeStore({ directory });
  const state = { pending: 0, notices: [], paused: false, runs: [], acknowledgements: [], retries: 0 };
  const adapter = {
    async observe() { return { project: { started: true, paused: state.paused, closed: false }, pending: 0, acknowledged: 0 }; },
    async retryCoordination(options) { state.retries++; await retry(state, options); },
    async deliveryState() { return { pending: state.pending, notices: structuredClone(state.notices) }; },
    async acknowledgeNotices(snapshot) {
      state.acknowledgements.push(structuredClone(snapshot));
      const consumed = new Set(snapshot.map(notice => JSON.stringify(notice)));
      state.notices = state.notices.filter(notice => !consumed.has(JSON.stringify(notice)));
    },
    async run(options) { state.runs.push(options.prompt); return run(state, options); },
    async release() {},
  };
  const controllers = createRuntimeControllers({ store: wrapStore(store), adapterFactory: async () => adapter, observeIntervalMs: 25 });
  t.after(async () => { await controllers.close(); await store.close(); await rm(directory, { recursive: true, force: true }); });
  const start = async () => {
    const accepted = await controllers.accept({ version: 2, operationId: randomUUID(), kind: 'start', target,
      missionId: randomUUID(), payload: { scope: 'Synthetic deferred coordination acceptance only', deadlineAt: Date.now() + 60000,
        execution: { provider: 'claude', model: null } } });
    return accepted.mission;
  };
  const inspect = mission => controllers.getMission({ target, missionId: mission.missionId });
  return { state, adapter, start, inspect };
}
async function acknowledged(options) { await options.onPromptSubmitted(); await options.onTurnStarted(); }

test('pending sends gate native work; coordination retry resolves them and supplies the exact notices without another model', async t => {
  let resolveSend = false;
  const notice = { id: 'synthetic-send', status: 'delivered', summary: 'Already sent the synthetic result.' };
  const ctx = await setup(t, {
    retry: async state => { if (resolveSend && state.pending) { state.pending = 0; state.notices.push(notice); } },
    run: async (_state, options) => { await acknowledged(options); return success; },
  });
  ctx.state.pending = 1;
  const mission = await ctx.start();
  await until(() => ctx.state.retries, value => value >= 2, 'non-model coordination retries');
  assert.equal(ctx.state.runs.length, 0);
  assert.equal((await ctx.inspect(mission)).outcomes.length, 0);
  resolveSend = true;
  await until(() => ctx.inspect(mission), value => value.outcomes.length === 1, 'result after send confirmation');
  await until(() => ctx.state.acknowledgements.length, value => value === 1, 'durable notice acknowledgement');
  assert.equal(ctx.state.runs.length, 1);
  assert.ok(ctx.state.runs[0].includes(`## Messages already sent\n\nThese deferred sends were already processed; do not send them again.\n\n- \`${JSON.stringify(notice)}\``));
  assert.deepEqual(ctx.state.acknowledgements, [[notice]]);
  assert.deepEqual(ctx.state.notices, []);
  await sleep(70);
  assert.equal(ctx.state.runs.length, 1);
});

test('notice acknowledgement waits for the SQLite outcome commit and clears only the observed snapshot', async t => {
  const entered = deferred(), release = deferred();
  t.after(() => release.resolve());
  const first = { id: 'first-send', status: 'delivered' }, later = { id: 'later-send', status: 'delivered' };
  let committed = false;
  const ctx = await setup(t, {
    wrapStore: store => ({ ...store, async recordTurn(value) {
      entered.resolve(); await release.promise;
      const mission = await store.recordTurn(value); committed = true; return mission;
    } }),
    run: async (state, options) => { await acknowledged(options); state.paused = true; return success; },
  });
  const originalAck = ctx.adapter.acknowledgeNotices;
  ctx.adapter.acknowledgeNotices = async snapshot => { assert.equal(committed, true); return originalAck(snapshot); };
  ctx.state.notices = [first];
  const mission = await ctx.start();
  await entered.promise;
  assert.equal((await ctx.inspect(mission)).outcomes.length, 0);
  assert.deepEqual(ctx.state.acknowledgements, []);
  ctx.state.notices.push(later);
  release.resolve();
  await until(() => ctx.state.acknowledgements.length, value => value === 1, 'commit before acknowledgement');
  assert.equal((await ctx.inspect(mission)).outcomes.length, 1);
  assert.deepEqual(ctx.state.acknowledgements, [[first]]);
  assert.deepEqual(ctx.state.notices, [later]);
});
