// In-memory adapters exercise scheduling/persistence only. No native executable or model is resolved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openRuntimeStore } from '../src/service/store.mjs';
import { createRuntimeControllers } from '../src/service/controllers.mjs';

const target = { site: 'https://fixture.invalid', ownerId: 'synthetic-owner', projectId: 'synthetic-project', agentId: 'synthetic-agent' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const result = (text = 'WORK_NEXT: waiting') => ({ text, delivery: 'acknowledged', failed: false, interrupted: false, retryable: false, cleanupConfirmed: true });
async function until(read, predicate, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const value = await read(); if (predicate(value)) return value; await sleep(10); }
  assert.fail(`Timed out: ${label}`);
}
function hold(frame) {
  return new Promise(resolve => {
    const finish = value => { frame.options.signal.removeEventListener('abort', abort); resolve(value); };
    const abort = () => { frame.aborted = true; finish({ ...result(''), interrupted: true }); };
    frame.finish = text => finish(result(text));
    frame.options.signal.addEventListener('abort', abort, { once: true });
    if (frame.options.signal.aborted) abort();
  });
}
async function setup(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'mlswarm-cloud-controller-'));
  const store = await openRuntimeStore({ directory });
  const ctx = { store, directory, starts: [], observes: 0, sessions: [], phases: [], frames: [], reportsReady: 0,
    paused: false, contact: true, fatal: false, messages: [] };
  const news = () => ({ project: { started: true, paused: ctx.paused, closed: false,
    ...(ctx.revision === undefined ? {} : { revision: ctx.revision }), ...(ctx.pauseRequest ? { pauseRequest: ctx.pauseRequest } : {}) }, pending: 0, acknowledged: 0 });
  const cloud = {
    async start(mission) { ctx.starts.push(structuredClone(mission)); return { runId: mission.missionId, cloudGeneration: 7, pollSeconds: 20 }; },
    async observe() {
      ctx.observes++;
      if (ctx.fatal) throw Object.assign(new Error('Synthetic revocation'), { code: 'unauthorized', fatal: true });
      if (!ctx.contact) throw Object.assign(new Error('Synthetic contact loss'), { code: 'unavailable' });
      return options.observe ? options.observe(ctx, news()) : news();
    },
    async workerSession(mission, session, args) { ctx.sessions.push(structuredClone(session)); return options.steering ? options.steering(ctx, mission, session, args)
      : { missionId: mission.missionId, authorizedDeadlineAt: mission.deadlineAt,
        messages: ctx.messages.map(item=>({...item,missionId:mission.missionId,generation:mission.generation})) }; },
    async phase(mission, phase, args) { ctx.phases.push(phase); return options.phase?.(ctx, mission, phase, args); },
    async reportStatus(...args) { return options.reportStatus?.(ctx, ...args); },
  };
  if (options.watch) {
    ctx.revision = 0;
    cloud.projectControl = async (_mission, { afterRevision, signal }) => {
      if (afterRevision !== ctx.revision) return news().project;
      return new Promise((resolve, reject) => {
        let timer;
        const abort = () => { clearTimeout(timer); ctx.projectListener = null; reject(signal.reason); };
        ctx.projectListener = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); ctx.projectListener = null; resolve(news().project); };
        signal.addEventListener('abort', abort, { once: true });
        // Optional server hold timeout: answers with the unchanged revision.
        if (options.watchTimeoutMs) timer = setTimeout(() => { ctx.heldTimeouts = (ctx.heldTimeouts ?? 0) + 1; ctx.projectListener?.(); }, options.watchTimeoutMs);
      });
    };
    ctx.project = (paused, revision) => {
      ctx.paused = paused; ctx.revision = revision;
      ctx.pauseRequest = paused ? { revision, requestedAt: Date.now() } : undefined;
      ctx.projectListener?.();
    };
  }
  const adapter = {
    async observe() { assert.fail('A cloud-bound controller must use cloud observations'); },
    async run(args) {
      const frame = { options: args, aborted: false }; ctx.frames.push(frame);
      await args.onPromptSubmitted(); await args.onTurnStarted();
      return options.run ? options.run(ctx, frame) : result();
    },
    async release() {},
  };
  const controllers = createRuntimeControllers({ store: options.wrap ? options.wrap(store, ctx) : store,
    adapterFactory: async mission => { return options.adapterFactory ? options.adapterFactory(ctx, mission, adapter) : adapter; },
    cloudFactory: () => cloud, observeIntervalMs: options.observeIntervalMs ?? 15, onReportsReady: () => { ctx.reportsReady++; },
    // These tests assert when a change syncs; the C6-S spread is covered in runtime-shared-project-control.
    onChangeSpreadMs: options.onChangeSpreadMs ?? 0 });
  ctx.controllers = controllers;
  t.after(async () => { await controllers.close(); await store.close(); await rm(directory, { recursive: true, force: true }); });
  // Under three minutes of job, so the keep-going turns (see runtime-controllers.test.mjs) stay out of these counts.
  ctx.start = async () => {
    const input = { version: 2, operationId: randomUUID(), missionId: randomUUID(), kind: 'start', target,
      payload: { scope: 'Synthetic cloud controller acceptance', deadlineAt: Date.now() + (options.deadlineMs ?? 170000), execution: { provider: 'codex', model: null } } };
    ctx.mission = (await controllers.accept(input)).mission; return ctx.mission;
  };
  ctx.inspect = () => store.getMission({ missionId: ctx.mission.missionId, target });
  ctx.command = (kind, payload = {}) => controllers.accept({ version: 2, operationId: randomUUID(), kind, target,
    missionId: ctx.mission.missionId, generation: ctx.mission.generation, payload });
  return ctx;
}

test('an inbox retry explains the pending handoff and becomes idle after actual acknowledgment', async t => {
  const ctx = await setup(t, {
    observe(ctx, value) { return { ...value, pending: ctx.pending ?? 2, acknowledged: ctx.acked ?? 5 }; },
    async run(ctx, frame) {
      // Reproduce the experiment: finished implementation, but two inbox items
      // remain unread/unacknowledged when the first turn returns waiting.
      if (ctx.frames.length === 1) return result();
      assert.match(frame.options.prompt, /TURN_CONTEXT_JSON: {"trigger":"retry","inbox":{"pending":2,"acknowledged":5}}/);
      assert.match(frame.options.prompt, /Even if your implementation is finished/);
      assert.match(frame.options.prompt, /ack equal to the actual returned position/);
      assert.match(frame.options.prompt, /Do not infer an acknowledgment position/);
      // Simulate the agent reading/handling the two items and acknowledging the
      // tool's returned position, never a controller-side automatic ack.
      ctx.pending = 0; ctx.acked = 7;
      return result();
    },
  });
  await ctx.start();
  await until(async () => (await ctx.inspect()).outcomes.length, count => count === 2, 'inbox handoff completed after bounded backoff', 15000);
  await sleep(80);
  assert.equal(ctx.frames.length, 2, 'a handled inbox must not produce idle retry turns');
  assert.equal((await ctx.inspect()).state, 'waiting');
});

test('at the end of the job\'s time a turn finishes, the worker waits, and added time continues it', async t => {
  const ctx = await setup(t, { deadlineMs: 400,
    run: (ctx, frame) => ctx.frames.length === 1 ? hold(frame) : result(),
    steering: (ctx, mission) => ({ missionId: mission.missionId, authorizedDeadlineAt: ctx.authorized ?? mission.deadlineAt, messages: [] }) });
  const mission = await ctx.start();
  await until(() => ctx.frames.length, count => count === 1, 'first turn');
  await sleep(Math.max(0, mission.deadlineAt - Date.now()) + 150);
  assert.equal(ctx.frames[0].aborted, false, 'the end time does not interrupt a running turn');
  assert.equal((await ctx.inspect()).state, 'running');
  ctx.frames[0].finish('Finished past the end time.\nWORK_NEXT: runnable');
  await sleep(200);
  assert.equal(ctx.frames.length, 1, 'no new turn starts while the time is up');
  const waiting = await ctx.inspect();
  assert.equal(waiting.state, 'waiting'); assert.equal(waiting.deadlineAt, mission.deadlineAt);
  assert.equal((await ctx.store.listReports({ target, missionId: mission.missionId, limit: 100 })).reports.some(report => report.kind === 'stop_run'), false);
  ctx.authorized = Date.now() + 300000;
  await until(() => ctx.frames.length, count => count === 2, 'added time continues the waiting worker');
  assert.equal((await ctx.inspect()).deadlineAt, ctx.authorized);
  assert.match(ctx.frames[1].options.prompt, new RegExp(new Date(ctx.authorized).toISOString().replace(/[.]/g, '\\.')));
});

// A Codex turn: 1000 input of which 600 cached, 100 output, so it counts 500 tokens toward the cap.
const codexUsage = { provider: 'codex', inputSemantics: 'includes-cache', model: null, modelSource: 'unknown', tokens: { input: 1000, output: 100, cacheRead: 600, cacheWrite: 0, modelCalls: null } };
const capSteering = (ctx, mission) => ({ missionId: mission.missionId, authorizedDeadlineAt: mission.deadlineAt, messages: [], tokenLimit: ctx.tokenLimit ?? null });

test('a turn that crosses the token cap finishes, the worker waits at the cap, and raising the cap continues it', async t => {
  const ctx = await setup(t, { steering: capSteering,
    run: (ctx, frame) => ctx.frames.length === 1 ? hold(frame).then(value => ({ ...value, usage: codexUsage })) : { ...result(), usage: codexUsage } });
  ctx.tokenLimit = { tokens: 400, othersUsed: 0 };
  await ctx.start();
  await until(() => ctx.frames.length, count => count === 1, 'first turn under the cap');
  await sleep(100);
  assert.equal(ctx.frames[0].aborted, false, 'the cap never cuts a running turn');
  // The turn crosses the cap as it finishes, and says it has more to do.
  ctx.frames[0].finish('Crossed the cap.\nWORK_NEXT: runnable');
  await until(() => ctx.inspect(), m => m.state === 'waiting' && m.outcomes.length === 1, 'the crossing turn finished');
  await until(() => ctx.sessions, sessions => sessions.at(-1)?.tokens?.counted === 500 && sessions.at(-1).phase === 'waiting', 'it reports 500 counted tokens');
  await sleep(150);
  assert.equal(ctx.frames.length, 1, 'no new turn starts at the cap');
  assert.equal((await ctx.store.listReports({ target, missionId: ctx.mission.missionId, limit: 100 })).reports.some(report => report.kind === 'stop_run'), false, 'the cap does not end the run');
  ctx.tokenLimit = { tokens: 5000, othersUsed: 0 };
  await until(() => ctx.frames.length, count => count === 2, 'raising the cap continues the waiting worker');
});

test('removing the token cap continues a worker waiting at it', async t => {
  const ctx = await setup(t, { steering: capSteering, run: () => ({ ...result('Done.\nWORK_NEXT: runnable'), usage: codexUsage }) });
  ctx.tokenLimit = { tokens: 500, othersUsed: 0 };
  await ctx.start();
  await until(() => ctx.inspect(), m => m.state === 'waiting' && m.outcomes.length === 1, 'the turn reaching the cap finished');
  await sleep(150);
  assert.equal(ctx.frames.length, 1, 'exactly at the cap is at the cap');
  ctx.tokenLimit = null;
  await until(() => ctx.frames.length, count => count >= 2, 'no cap: it continues');
});

test('the cap is one pool: what it counted outside this mission counts toward it', async t => {
  const ctx = await setup(t, { steering: capSteering, run: () => ({ ...result('More to do.\nWORK_NEXT: runnable'), usage: codexUsage }) });
  const settledAt = async count => {
    await until(() => ctx.inspect(), m => m.state === 'waiting' && m.outcomes.length === count, `${count} turns, then waiting`);
    await sleep(200);
    assert.equal(ctx.frames.length, count, 'no turn starts at the cap');
  };
  // Own 0 + 900 has room under 1400; own 500 + 900 does not.
  ctx.tokenLimit = { tokens: 1400, othersUsed: 900 };
  await ctx.start();
  await settledAt(1);
  // Raised: own 500, 1000, 1500 and 2000 + 900 have room under 3000; 2500 + 900 does not.
  ctx.tokenLimit = { tokens: 3000, othersUsed: 900 };
  await settledAt(5);
});

test('without a token cap a worker keeps working whatever it uses', async t => {
  const big = { ...codexUsage, tokens: { ...codexUsage.tokens, input: 10_000_000 } };
  const ctx = await setup(t, { steering: capSteering, run: ctx => ({ ...result(ctx.frames.length < 3 ? 'More.\nWORK_NEXT: runnable' : 'WORK_NEXT: waiting'), usage: big }) });
  await ctx.start();
  await until(() => ctx.inspect(), m => m.state === 'waiting' && m.outcomes.length === 3, 'three runnable turns, as before caps');
  await until(() => ctx.sessions, sessions => sessions.some(s => s.tokens?.counted === 3 * (10_000_000 - 600 + 100)), 'tokens are counted and reported with no cap');
});

test('a killed worker\'s final contact keeps its token count, so its tokens stay in the pool', async t => {
  const ctx = await setup(t, { steering: capSteering, run: () => ({ ...result('Done.\nWORK_NEXT: waiting'), usage: codexUsage }) });
  ctx.tokenLimit = { tokens: 5000, othersUsed: 0 };
  await ctx.start();
  await until(() => ctx.inspect(), m => m.state === 'waiting' && m.outcomes.length === 1, 'one counted turn');
  await ctx.command('stop');
  await until(() => ctx.inspect(), m => m.state === 'stopped', 'killed');
  const stop = (await ctx.store.listReports({ target, missionId: ctx.mission.missionId, limit: 100 })).reports.find(report => report.kind === 'stop_run');
  assert.deepEqual(stop.payload.worker_session.tokens, { counted: 500, unknownTurns: 0 });
});

// Fresh contact (a successful observation) is not enough: the worker waits for its first session reply. Here the first
// sync fails, and the next one is still in flight after its observation succeeded, so the worker has fresh contact
// and only the unknown cap holds it. A reply with no tokenLimit field (a server from before token caps) means no cap:
// the worker then works and does not hang.
test('a cloud worker with fresh contact starts no turn until a session reply arrived; a reply without tokenLimit means no cap', async t => {
  const reply = deferred();
  t.after(() => reply.resolve());
  const ctx = await setup(t, { steering: (ctx, mission) => {
    if (ctx.sessions.length === 1) throw Object.assign(new Error('Synthetic session loss'), { code: 'unavailable' });
    return reply.promise.then(() => ({ missionId: mission.missionId, authorizedDeadlineAt: mission.deadlineAt, messages: [] }));
  } });
  await ctx.start();
  await until(() => ctx.sessions.length, count => count >= 2, 'the second session sync is in flight after a fresh observation');
  await sleep(200);
  assert.equal(ctx.frames.length, 0, 'no turn before a session reply');
  reply.resolve();
  await until(() => ctx.frames.length, count => count === 1, 'an old server\'s reply allows work', 15000);
});

test('added time that has already passed when it arrives leaves the worker waiting in contact, and messages still flow', async t => {
  const ctx = await setup(t, { deadlineMs: 300,
    steering: (ctx, mission) => ({ missionId: mission.missionId, authorizedDeadlineAt: ctx.authorized ?? mission.deadlineAt,
      messages: ctx.messages.map(item => ({ ...item, missionId: mission.missionId, generation: mission.generation })) }) });
  const mission = await ctx.start();
  await until(() => ctx.frames.length, count => count === 1, 'first turn');
  await sleep(Math.max(0, mission.deadlineAt - Date.now()) + 100);
  // The owner added time, but the computer only hears of it after the new end passed too.
  ctx.authorized = mission.deadlineAt + 50;
  ctx.messages = [{ id: randomUUID(), body: 'Synthetic steer while time is up' }];
  const seen = ctx.sessions.length;
  await until(() => ctx.sessions.length, count => count >= seen + 3, 'contact continues');
  const waiting = await ctx.inspect();
  assert.equal(waiting.state, 'waiting');
  assert.equal(waiting.steering.length, 1, 'a message in the same reply is still received');
  assert.equal(ctx.frames.length, 1, 'no turn starts while the time is up');
  ctx.authorized = Date.now() + 300000;
  await until(() => ctx.frames.length, count => count === 2, 'time added later still continues the worker');
});

test('project Pause lets the turn finish and confirms only after native cleanup; Resume preserves the mission', async t => {
  const cleanup = deferred();
  t.after(() => cleanup.resolve());
  const ctx = await setup(t, { watch: true, observeIntervalMs: 10000, async run(_ctx, frame) {
    const outcome = await hold(frame); await cleanup.promise; return outcome;
  } });
  await ctx.start(); await until(() => ctx.frames, frames => !!frames[0]?.finish, 'active worker');
  await until(() => ctx.projectListener, Boolean, 'held project connection');
  const missionId = ctx.mission.missionId;
  ctx.project(true, 1);
  // Pause lets the running turn finish (owner decision, 9 November 2026).
  await sleep(100);
  assert.notEqual(ctx.frames[0].aborted, true, 'project pause does not interrupt native work');
  assert.equal(ctx.sessions.some(s => s.projectPauseRevision !== undefined), false);
  ctx.frames[0].finish('Synthetic turn done.');
  await sleep(50);
  assert.equal(ctx.sessions.some(s => s.projectPauseRevision !== undefined), false, 'no confirmation before cleanup');
  cleanup.resolve();
  // Then one short turn posts the update; the Pause is confirmed after it (owner, 10 November 2026).
  await until(() => ctx.frames[1]?.finish, Boolean, 'the pause update turn');
  assert.equal(ctx.frames[1].options.pauseUpdate, true);
  assert.match(ctx.frames[1].options.prompt, /The project was just paused/);
  assert.equal(ctx.sessions.some(s => s.projectPauseRevision !== undefined), false, 'no confirmation during the update turn');
  ctx.frames[1].finish('Posted the update.');
  await until(() => ctx.sessions, sessions => sessions.some(s => s.phase === 'paused' && s.projectPauseRevision === 1), 'exact confirmed pause');
  assert.equal(ctx.observes, 1, 'the held connection delivers Pause and its receipt without another /wait poll');
  await sleep(60); assert.equal(ctx.frames.length, 2, 'one update turn only');
  ctx.project(false, 2);
  await until(() => ctx.frames.length, n => n === 3, 'same mission resumes');
  assert.equal((await ctx.inspect()).missionId, missionId);
});

test('an unchanged held project-control timeout re-holds without another worker-session sync', async t => {
  const ctx = await setup(t, { watch: true, observeIntervalMs: 10000, watchTimeoutMs: 15 });
  await ctx.start();
  await until(() => ctx.phases, phases => phases.includes('idle'), 'first turn settles');
  await until(() => ctx.heldTimeouts ?? 0, n => n >= 2, 'held request timed out unchanged');
  const settled = ctx.sessions.length;
  await until(() => ctx.heldTimeouts, n => n >= 10, 'several unchanged timeouts');
  assert.equal(ctx.sessions.length, settled, 'unchanged timeouts send no worker-session sync');
  assert.equal(ctx.observes, 1, 'and no extra /wait poll');
  ctx.project(true, 1);
  await until(() => ctx.sessions, sessions => sessions.some(s => s.projectPauseRevision === 1), 'a changed revision still syncs promptly');
});

test('stale periodic state cannot release a project hold or confirm a later pause', async t => {
  const ctx = await setup(t, { watch: true, run: (_ctx, frame) => hold(frame),
    observe: (_ctx, value) => ({ ...value, project: { started: true, paused: false, closed: false, revision: 0 } }) });
  await ctx.start(); await until(() => ctx.frames, frames => !!frames[0]?.finish, 'active worker');
  await until(() => ctx.projectListener, Boolean, 'watch ready');
  ctx.project(true, 1); ctx.frames[0].finish('Turn done.');
  // Each Pause after work gets one update turn before it is confirmed.
  await until(() => ctx.frames, frames => frames[1]?.options.pauseUpdate === true && !!frames[1].finish, 'pause update turn');
  ctx.frames[1].finish('Update posted.');
  await until(() => ctx.sessions, sessions => sessions.some(s => s.projectPauseRevision === 1), 'pause despite stale polling');
  await sleep(70); assert.equal(ctx.frames.length, 2);
  ctx.project(false, 2);
  await until(() => ctx.frames, frames => !!frames[2]?.finish, 'resumed turn');
  ctx.project(true, 3); ctx.frames[2].finish('Turn done.');
  await until(() => ctx.frames, frames => frames[3]?.options.pauseUpdate === true && !!frames[3].finish, 'second pause update turn');
  ctx.frames[3].finish('Update posted.');
  await until(() => ctx.sessions, sessions => sessions.some(s => s.projectPauseRevision === 3), 'new pause has its own confirmation');
  assert.equal(ctx.frames.length, 4);
});

test('project Resume cannot release an individual Pause', async t => {
  const ctx = await setup(t, { watch: true, run: (_ctx, frame) => hold(frame) });
  await ctx.start(); await until(() => ctx.frames, frames => !!frames[0]?.finish, 'active worker');
  await ctx.command('pause'); ctx.frames[0].finish('Turn done.');
  await until(ctx.inspect, mission => mission.state === 'paused', 'individual pause settles');
  await until(() => ctx.projectListener, Boolean, 'watch ready');
  ctx.project(true, 1);
  await until(() => ctx.sessions, sessions => sessions.some(s => s.projectPauseRevision === 1), 'project hold acknowledged');
  ctx.project(false, 2); await sleep(90);
  assert.equal(ctx.frames.length, 1); assert.equal((await ctx.inspect()).state, 'paused');
});

test('uncertain native cleanup never confirms project Pause', async t => {
  const ctx = await setup(t, { watch: true, async run(_ctx, frame) { return { ...await hold(frame), cleanupConfirmed: false }; } });
  await ctx.start(); await until(() => ctx.frames, frames => !!frames[0]?.finish, 'active worker');
  await until(() => ctx.projectListener, Boolean, 'watch ready'); ctx.project(true, 1); ctx.frames[0].finish('Turn done.');
  await until(ctx.inspect, mission => mission.state === 'recovery_required', 'uncertainty remains protected');
  assert.equal(ctx.sessions.some(s => s.projectPauseRevision !== undefined), false);
});

test('cloud run intent and binding persist before the in-memory adapter can execute', async t => {
  let checked = false;
  const ctx = await setup(t, { async adapterFactory(c, mission, adapter) {
    const saved = await c.store.getMission({ missionId: mission.missionId, target });
    assert.equal(saved.cloudRun.runId, mission.missionId); assert.equal(saved.cloudRun.generation, 7);
    checked = true; return adapter;
  } });
  await ctx.start(); const saved = await until(ctx.inspect, mission => mission.outcomes.length === 1, 'saved outcome');
  assert.equal(checked, true); assert.equal(ctx.starts.length, 1); assert.equal(ctx.starts[0].cloudRun.generation, null);
  assert.equal(saved.outcomes.length, 1); assert.equal((await ctx.store.listReports({ missionId: saved.missionId })).reports[0].kind, 'turn_report');
  assert.ok(ctx.reportsReady > 0);
});

test('recorded steering deduplicates and waits for the current native turn', async t => {
  const ctx=await setup(t,{run:(_ctx,frame)=>hold(frame)});
  await ctx.start();await until(()=>ctx.frames,frames=>Boolean(frames[0]?.finish),'active first turn');
  const id=randomUUID();ctx.messages.push({id,body:'Synthetic shared guidance'});
  await until(ctx.inspect,mission=>mission.steering.length===1,'durable shared steering');
  await assert.rejects(ctx.command('steer',{message:'Must record first'}),e=>e.code==='forbidden');
  await sleep(50);assert.equal(ctx.frames.length,1);assert.equal(ctx.frames[0].options.signal.aborted,false);
  const reports=(await ctx.store.listReports({missionId:ctx.mission.missionId})).reports;
  assert.ok(reports.some(r=>r.kind==='steering_receipt'&&r.payload.state==='received'));
  ctx.frames[0].finish('WORK_NEXT: waiting');
  await until(()=>ctx.frames,frames=>Boolean(frames[1]?.finish),'second turn');
  assert.match(ctx.frames[1].options.prompt,/Synthetic shared guidance/);
  assert.equal((await ctx.inspect()).steering[0].state,'applied');
});

test('transient contact loss drains active work and gates the next turn until fresh contact returns', async t => {
  const ctx = await setup(t, { run: (_ctx, frame) => hold(frame) });
  await ctx.start(); await until(() => ctx.frames, frames => Boolean(frames[0]?.finish), 'first turn');
  ctx.contact = false; const reads = ctx.observes;
  await until(() => ctx.observes, value => value > reads, 'failed contact');
  assert.equal(ctx.frames[0].options.signal.aborted, false);
  ctx.frames[0].finish('WORK_NEXT: runnable');
  await until(ctx.inspect, mission => mission.outcomes.length === 1, 'saved active turn');
  await sleep(80); assert.equal(ctx.frames.length, 1);
  ctx.contact = true; await until(() => ctx.frames, frames => Boolean(frames[1]?.finish), 'fresh contact permits continuation');
});

test('fatal cloud revocation cancels an active adapter and retains its result plus stop report', async t => {
  const ctx = await setup(t, { run: (_ctx, frame) => hold(frame) });
  await ctx.start(); await until(() => ctx.frames, frames => Boolean(frames[0]?.finish), 'active turn');
  ctx.fatal = true;
  const stopped = await until(ctx.inspect, mission => mission.state === 'stopped', 'revocation stop');
  assert.equal(ctx.frames[0].aborted, true); assert.equal(stopped.reason, 'cloud_refused');
  const reports = (await ctx.store.listReports({ missionId: stopped.missionId })).reports;
  assert.deepEqual(reports.map(entry => entry.kind).sort(), ['stop_run', 'turn_report']);
});

for (const boundary of ['phase', 'prepare']) {
  test(`pause observed during awaited ${boundary} setup prevents a new adapter turn`, async t => {
    const gate = deferred(), entered = deferred();
    const ctx = await setup(t, {
      async phase(_ctx, _mission, phase) { if (boundary === 'phase' && phase === 'turn') { entered.resolve(); await gate.promise; } },
      wrap(store) { return boundary !== 'prepare' ? store : { ...store, async prepareTurn(input) { const result = await store.prepareTurn(input); entered.resolve(); await gate.promise; return result; } }; },
    });
    t.after(() => gate.resolve()); await ctx.start(); await entered.promise;
    ctx.paused = true; const reads = ctx.observes; await until(() => ctx.observes, value => value > reads, 'known paused observation');
    gate.resolve(); await sleep(90); assert.equal(ctx.frames.length, 0);
    ctx.paused = false; await until(() => ctx.frames, frames => frames.length === 1, 'resumed project launches after setup was deferred');
  });
}

test('a status refused for a passing reason is resent on the next cloud tick until it is confirmed', async t => {
  const sent = [];
  const ctx = await setup(t, { observeIntervalMs: 15,
    reportStatus(_ctx, _mission, status) { sent.push(status); if (sent.length === 1) throw Object.assign(new Error('Synthetic rate limit'), { code: 'rate_limited', fatal: false }); },
    async run(_ctx, frame) { frame.options.onStatus('Mapping freshness legs'); return hold(frame); } });
  await ctx.start();
  await until(() => sent.length, n => n >= 2, 'refused status resent');
  assert.deepEqual(sent.slice(0, 2), ['Mapping freshness legs', 'Mapping freshness legs']);
  // Once confirmed, later ticks send nothing more.
  const confirmed = sent.length; await sleep(120);
  assert.equal(sent.length, confirmed);
  ctx.frames[0].finish('WORK_NEXT: waiting');
});

test('a status refused as fatal is not resent', async t => {
  const sent = [];
  const ctx = await setup(t, { observeIntervalMs: 15,
    reportStatus(_ctx, _mission, status) { sent.push(status); throw Object.assign(new Error('Synthetic invalid status'), { code: 'bad_input', fatal: true }); },
    async run(_ctx, frame) { frame.options.onStatus('Not resent'); return hold(frame); } });
  await ctx.start();
  await until(() => sent.length, n => n >= 1, 'status sent once');
  await until(() => ctx.sessions.length, n => n >= 3, 'later cloud ticks');
  assert.equal(sent.length, 1);
  ctx.frames[0].finish('WORK_NEXT: waiting');
});

test('a status refused for a lasting reason is not resent, even when it is not marked fatal', async t => {
  const sent = [];
  const ctx = await setup(t, { observeIntervalMs: 15,
    reportStatus(_ctx, _mission, status) { sent.push(status); throw Object.assign(new Error('Synthetic validation refusal'), { code: 'bad_input', fatal: false }); },
    async run(_ctx, frame) { frame.options.onStatus('Not resent either'); return hold(frame); } });
  await ctx.start();
  await until(() => sent.length, n => n >= 1, 'status sent once');
  await until(() => ctx.sessions.length, n => n >= 3, 'later cloud ticks');
  assert.equal(sent.length, 1);
  ctx.frames[0].finish('WORK_NEXT: waiting');
});
