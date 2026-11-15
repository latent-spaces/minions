// In-memory adapters and a fake cloud: counts held project-control requests per project. No model runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openRuntimeStore } from '../src/service/store.mjs';
import { createRuntimeControllers } from '../src/service/controllers.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, predicate, label) {
  for (let i = 0; i < 400; i++) { const value = read(); if (predicate(value)) return value; await sleep(5); }
  assert.fail(`${label}: ${JSON.stringify(read())}`);
}
const target = (projectId, agentId, site = 'https://fixture.invalid') => ({ site, ownerId: 'synthetic-owner', projectId, agentId });

async function setup(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'minions-shared-control-'));
  const store = await openRuntimeStore({ directory });
  const projects = new Map(), held = new Map(), holders = [], sessions = [], refusals = new Map(), afters = [], payloads = [], lagging = new Map();
  const calls = [], syncTimes = [], observeTimes = [];
  const keyOf = m => m.target.site === 'https://fixture.invalid' ? m.target.projectId : `${m.target.site}|${m.target.projectId}`;
  const state = id => { if (!projects.has(id)) projects.set(id, { revision: 0, paused: false, listeners: new Set() }); return projects.get(id); };
  const view = p => ({ started: true, paused: p.paused, closed: false, revision: p.revision, ...(p.paused ? { pauseRequest: { revision: p.revision, requestedAt: 1 } } : {}) });
  const cloudFor = mission => ({
    async start(m) { return { runId: m.missionId, cloudGeneration: 7, pollSeconds: 20 }; },
    async observe(m) { observeTimes.push({ agent: m.target.agentId, t: Date.now() }); return { project: view(state(keyOf(m))), pending: 0, acknowledged: 0 }; },
    async workerSession(m, session) { sessions.push(m.target.agentId); syncTimes.push(Date.now()); payloads.push({ agent: m.target.agentId, site: m.target.site, ...session }); options.onSession?.(m.target.agentId); return { missionId: m.missionId, authorizedDeadlineAt: m.deadlineAt, messages: [], ...(options.tokenLimit ? { tokenLimit: options.tokenLimit } : {}) }; },
    async phase() {}, async reportStatus() {},
    async projectControl(m, { afterRevision, signal }) {
      const id = keyOf(m), p = state(id);
      holders.push(`${m.target.projectId}/${m.target.agentId}`); afters.push(afterRevision);
      calls.push({ project: m.target.projectId, at: Date.now() });
      // A lagging server listener: one answer older than the caller's revision, as at a hold timeout.
      if (lagging.get(id) !== undefined) { const revision = lagging.get(id); lagging.delete(id); return { ...view(p), revision }; }
      const refusal = refusals.get(m.target.agentId);
      if (refusal) { if (refusal.once) refusals.delete(m.target.agentId); throw Object.assign(new Error('synthetic refusal'), refusal.error); }
      if (afterRevision !== p.revision) return view(p);
      held.set(id, (held.get(id) ?? 0) + 1);
      try {
        return await new Promise((resolve, reject) => {
          const wake = () => { signal.removeEventListener('abort', abort); p.listeners.delete(wake); resolve(view(p)); };
          const abort = () => { p.listeners.delete(wake); reject(signal.reason); };
          p.listeners.add(wake); signal.addEventListener('abort', abort, { once: true });
        });
      } finally { held.set(id, held.get(id) - 1); }
    },
  });
  let busy = 0;
  const runs = [];
  const adapter = { async observe() { assert.fail('cloud-bound'); }, async release() {},
    async run(args) { runs.push({ pauseUpdate: args.pauseUpdate === true }); await args.onPromptSubmitted(); await args.onTurnStarted();
      // A project change starts a turn (work-controller 'project_change'); real turns take model time.
      if (options.turnMs) {
        // Kill aborts the turn, as a native worker would be interrupted. A Pause lets it finish.
        busy++;
        const aborted = await new Promise(resolve => {
          const timer = setTimeout(() => resolve(false), options.turnMs);
          args.signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(true); }, { once: true });
        }).finally(() => { busy--; });
        if (aborted) return { text: '', delivery: 'acknowledged', failed: false, interrupted: true, retryable: true, cleanupConfirmed: true };
      }
      return { text: 'WORK_NEXT: waiting', delivery: 'acknowledged', failed: false, interrupted: false, retryable: false, cleanupConfirmed: true, ...(options.usage ? { usage: options.usage } : {}) }; } };
  const controllers = createRuntimeControllers({ store, adapterFactory: async () => adapter, cloudFactory: cloudFor, observeIntervalMs: options.observeIntervalMs ?? 10000, ...(options.random ? { random: options.random } : {}),
    onChangeSpreadMs: options.onChangeSpreadMs ?? 0 });
  t.after(async () => { await controllers.close(); await store.close(); await rm(directory, { recursive: true, force: true }); });
  const start = async (projectId, agentId, site) => (await controllers.accept({ version: 2, operationId: randomUUID(), missionId: randomUUID(), kind: 'start',
    target: target(projectId, agentId, site), payload: { scope: 'Synthetic shared control', deadlineAt: Date.now() + 300000, execution: { provider: 'codex', model: null } } })).mission;
  const stop = mission => controllers.accept({ version: 2, operationId: randomUUID(), kind: 'stop', target: mission.target,
    missionId: mission.missionId, generation: mission.generation, payload: {} });
  const change = (id, paused) => { const p = state(id); p.revision++; p.paused = paused; for (const wake of [...p.listeners]) wake(); };
  // Answers the current hold with an unchanged revision, like a server timeout.
  const timeout = id => { for (const listener of [...state(id).listeners]) listener(); };
  // Later turns finish at once, and the running ones are waited out: a Pause never cuts a turn short.
  const idle = async () => { options.turnMs = 0; while (busy) await sleep(10); };
  const pause = mission => controllers.accept({ version: 2, operationId: randomUUID(), kind: 'pause', target: mission.target,
    missionId: mission.missionId, generation: mission.generation, payload: {} });
  return { runs, pause, start, stop, change, timeout, idle, busy: () => busy, held, holders, sessions, refusals, afters, payloads, lagging, state, calls, syncTimes, observeTimes };
}

test('missions of one project on one computer share a single held request; every mission gets each change', async t => {
  const f = await setup(t);
  for (const agent of ['a', 'b', 'c']) await f.start('park', agent);
  await f.start('garden', 'd');
  await until(() => [f.held.get('park'), f.held.get('garden')], ([p, g]) => p === 1 && g === 1, 'one hold per project');
  await sleep(40);
  assert.equal(f.held.get('park'), 1, 'three park missions still hold one request');
  const before = f.sessions.length;
  f.change('park', true);
  // Each park mission syncs its own session after the shared answer; garden is untouched.
  await until(() => f.sessions.slice(before), s => ['a', 'b', 'c'].every(agent => s.includes(agent)), 'every member applied the change');
  assert.equal(f.sessions.slice(before).includes('d'), false);
  await until(() => f.held.get('park'), n => n === 1, 're-held once');
});

test('when the holding mission ends, another member takes over the single hold', async t => {
  const f = await setup(t);
  const a = await f.start('park', 'a'), b = await f.start('park', 'b');
  await until(() => f.held.get('park'), n => n === 1, 'one hold');
  const holder = f.holders.at(-1).split('/')[1];
  await f.stop(holder === 'a' ? a : b);
  const other = holder === 'a' ? 'b' : 'a';
  await until(() => f.holders.at(-1), last => last === `park/${other}`, 'the other mission holds now');
  await until(() => f.held.get('park'), n => n === 1, 'still exactly one hold');
  const before = f.sessions.length;
  f.change('park', false);
  await until(() => f.sessions.slice(before), s => s.includes(other), 'the remaining member still receives changes');
});

test('a refusal of the holder\'s own credential hands the hold over at once; the others keep running', async t => {
  const f = await setup(t);
  await f.start('park', 'a'); await f.start('park', 'b');
  await until(() => f.held.get('park'), n => n === 1, 'one hold');
  f.change('park', false);  // revision 1, applied to both
  await until(() => f.held.get('park'), n => n === 1, 're-held at revision 1');
  const holder = f.holders.at(-1).split('/')[1], other = holder === 'a' ? 'b' : 'a';
  f.refusals.set(holder, { error: { code: 'unauthorized', fatal: true } });
  f.timeout('park');  // the holder re-holds, is refused, and stops
  // observeIntervalMs is 10 s, so a group back-off would fail this wait.
  await until(() => f.holders.at(-1), last => last === `park/${other}`, 'immediate takeover');
  assert.equal(f.afters.at(-1), 1, 'the successor carries the group revision');
  await until(() => f.held.get('park'), n => n === 1, 'one hold again');
});

test('a rate-limited hold backs off the whole group instead of rotating to another member', async t => {
  const f = await setup(t);
  await f.start('park', 'a'); await f.start('park', 'b');
  await until(() => f.held.get('park'), n => n === 1, 'one hold');
  const holder = f.holders.at(-1).split('/')[1];
  f.refusals.set(holder, { once: true, error: { code: 'rate_limited', retryAfter: 1 } });
  const attempts = f.holders.length;
  f.timeout('park');
  await sleep(300);
  // One re-hold attempt was refused; nobody else holds during the back-off.
  assert.equal(f.holders.length, attempts + 1);
  assert.equal(f.held.get('park'), 0);
});

test('an older answer (a lagging listener at its timeout) never lowers the group revision or re-syncs members', async t => {
  const f = await setup(t);
  await f.start('park', 'a'); await f.start('park', 'b');
  await until(() => f.held.get('park'), n => n === 1, 'one hold');
  f.change('park', false); f.change('park', false);  // revision 2
  await until(() => f.afters.at(-1), r => r === 2, 'holding at revision 2');
  await until(() => f.held.get('park'), n => n === 1, 're-held');
  const from = f.afters.length;
  f.lagging.set('park', 1);
  f.timeout('park');  // unchanged answer, then the re-hold is answered with the older revision 1
  await until(() => f.afters.length - from, n => n >= 2, 'held again after the older answer');
  await until(() => f.held.get('park'), n => n === 1, 'holding');
  // Never re-held at the older revision (which would answer at once and re-sync every member).
  assert.deepEqual(f.afters.slice(from), [2, 2]);
});

test('no change is lost while members join, stop and hand the hold over', async t => {
  const f = await setup(t);
  let seed = 7; const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const live = new Map();
  for (const agent of ['a', 'b', 'c']) live.set(agent, await f.start('park', agent));
  let next = 0;
  for (let step = 0; step < 24; step++) {
    const roll = random();
    if (roll < 0.45) f.change('park', random() < 0.5);
    else if (roll < 0.75 && live.size > 1) {
      const agents = [...live.keys()], agent = agents[Math.floor(random() * agents.length)];
      await f.stop(live.get(agent)); live.delete(agent);
    } else { const agent = `n${next++}`; live.set(agent, await f.start('park', agent)); }
    await sleep(Math.floor(random() * 15));
  }
  f.change('park', true);
  const final = f.state('park').revision;
  // Every live member confirms the final Pause revision through its own session sync.
  for (const agent of live.keys())
    await until(() => f.payloads.some(p => p.agent === agent && p.projectPauseRevision === final), x => x, `member ${agent} saw revision ${final}`);
  await until(() => f.held.get('park'), n => n === 1, 'still exactly one hold');
});

test('one project id on two sites keeps two separate holds and never crosses answers', async t => {
  const f = await setup(t);
  await f.start('park', 'a'); await f.start('park', 'b');
  await f.start('park', 'x', 'https://other.invalid'); await f.start('park', 'y', 'https://other.invalid');
  await until(() => [f.held.get('park'), f.held.get('https://other.invalid|park')], ([one, two]) => one === 1 && two === 1, 'one hold per site');
  const before = f.payloads.length;
  f.change('park', true);
  await until(() => f.payloads.slice(before), p => ['a', 'b'].every(agent => p.some(x => x.agent === agent && x.projectPauseRevision === 1)), 'site one paused');
  await sleep(40);
  assert.equal(f.payloads.some(p => p.site === 'https://other.invalid' && p.projectPauseRevision !== undefined), false, 'the other site never paused');
});

test('holds that fail together come back spread over 1-1.5x the back-off, never sooner', async t => {
  // Each mission start draws its tick phase (C6-T) first. Then each failure draws twice (the member's tick retry,
  // then the group's hold back-off): the first group to fail draws 0, the second 0.99. The hold back-off base is
  // max(interval, 1 s) = 1 s.
  const draws = [0.5, 0.5, 0, 0, 0.99, 0.99];
  const f = await setup(t, { observeIntervalMs: 200, random: () => draws.length ? draws.shift() : 0.5 });
  await f.start('park', 'a'); await f.start('garden', 'b');
  await until(() => [f.held.get('park'), f.held.get('garden')], ([p, g]) => p === 1 && g === 1, 'both held');
  // An outage: both re-holds fail with a transport error at the same moment.
  for (const agent of ['a', 'b']) f.refusals.set(agent, { once: true, error: { code: 'unavailable' } });
  const failedAt = Date.now(), from = f.calls.length;
  f.timeout('park'); f.timeout('garden');
  await until(() => f.calls.slice(from), c => ['park', 'garden'].every(p => c.filter(x => x.project === p).length >= 2), 'both re-held');
  const retry = p => f.calls.slice(from).filter(x => x.project === p)[1].at - failedAt;
  const [early, late] = [retry('park'), retry('garden')].sort((x, y) => x - y);
  assert.ok(early >= 990, `never sooner than the 1 s back-off (${early} ms)`);
  assert.ok(late - early >= 300, `spread apart (${early} ms vs ${late} ms)`);
  assert.ok(late < 1500 + 150, `within 1.5x plus scheduling (${late} ms)`);
});

test('a server that keeps answering older state at once is re-held at a bounded pace, not in a tight loop', async t => {
  const f = await setup(t, { observeIntervalMs: 2000 });  // pause after an older answer: 2000 / 20 = 100 ms
  await f.start('park', 'a');
  await until(() => f.held.get('park'), n => n === 1, 'one hold');
  f.change('park', false); f.change('park', false);  // revision 2
  await until(() => f.afters.at(-1), r => r === 2, 'holding at revision 2');
  await until(() => f.held.get('park'), n => n === 1, 'held at revision 2');
  const from = f.calls.length;
  // Every re-hold is answered older at once until the test lifts it.
  f.lagging.delete = () => true; f.lagging.set('park', 1);
  t.after(() => Map.prototype.delete.call(f.lagging, 'park'));
  f.timeout('park');
  await sleep(500);
  const spins = f.calls.length - from;
  Map.prototype.delete.call(f.lagging, 'park');
  assert.ok(spins >= 2 && spins <= 8, `about one re-hold per 100 ms, not hundreds (${spins})`);
  assert.ok(f.afters.slice(from).every(r => r === 2), 'always re-held at the newest revision');
});

test('a change spreads each member\'s session sync over the window; a new Pause between turns is confirmed at once', async t => {
  // Draws per member: 0.1, 0.5, 0.9 of the 600 ms window.
  const draws = [0.1, 0.5, 0.9];
  const f = await setup(t, { onChangeSpreadMs: 600, turnMs: 3000, random: () => draws.length ? draws.shift() : 0.5 });
  for (const agent of ['a', 'b', 'c']) await f.start('park', agent);
  await until(() => f.held.get('park'), n => n === 1, 'one hold');
  await sleep(700);  // let the first answer's spread syncs settle
  // A non-pause change (e.g. a card edit): no member syncs at once; all sync within the window, spread apart.
  draws.push(0.1, 0.5, 0.9);
  const before = f.payloads.length, changedAt = Date.now();
  f.change('park', false);
  await sleep(40);
  assert.equal(f.payloads.length, before, 'nobody syncs at the moment of a non-pause change');
  await until(() => f.payloads.slice(before).map(p => p.agent), s => ['a', 'b', 'c'].every(x => s.includes(x)), 'all members sync within the window');
  const times = f.syncTimes.slice(before).map(x => x - changedAt).sort((x, y) => x - y);
  assert.ok(times.at(-1) - times[0] >= 300, `syncs are spread apart (${times.join(', ')} ms)`);
  assert.ok(times.at(-1) < 600 + 200, `within the window plus scheduling (${times.at(-1)} ms)`);
  // A new Pause between turns: every member applies it and confirms at once, with no spread.
  // (During a turn the confirmation waits for the turn to finish; owner decision, 9 November 2026.)
  await f.idle(); await sleep(50);
  const pauseFrom = f.payloads.length, pausedAt = Date.now();
  f.change('park', true);
  await until(() => f.payloads.slice(pauseFrom).filter(p => p.projectPauseRevision !== undefined).map(p => p.agent),
    s => ['a', 'b', 'c'].every(x => s.includes(x)), 'every member confirms the Pause');
  const confirms = f.payloads.map((p, i) => ({ p, t: f.syncTimes[i] })).slice(pauseFrom).filter(x => x.p.projectPauseRevision !== undefined);
  assert.ok(Math.max(...confirms.map(x => x.t - pausedAt)) < 400, 'Pause confirmations are not spread (window is 600 ms)');
});

test('a project Pause during a running turn is confirmed only after that turn ends', async t => {
  const f = await setup(t, { turnMs: 600 });
  await f.start('park', 'a');
  await until(() => f.busy(), n => n === 1, 'the turn is running');
  const from = f.payloads.length, pausedAt = Date.now();
  f.change('park', true);
  await sleep(200);
  assert.equal(f.busy(), 1, 'the Pause does not cut the turn short');
  assert.equal(f.payloads.slice(from).some(p => p.projectPauseRevision !== undefined), false, 'not confirmed while the turn runs');
  await until(() => f.payloads.slice(from).find(p => p.projectPauseRevision !== undefined), Boolean, 'confirmed once the turn ends');
  assert.equal(f.busy(), 0);
  assert.ok(Date.now() - pausedAt >= 400, 'confirmation followed the turn');
});

test('changes inside the window coalesce to one sync per member, and a Pause that arrives meanwhile syncs once at once', async t => {
  const f = await setup(t, { onChangeSpreadMs: 400, turnMs: 3000, random: () => 0.99 });
  await f.start('park', 'a');
  await until(() => f.held.get('park'), n => n === 1, 'one hold');
  await sleep(500);
  const before = f.payloads.length;
  f.change('park', false); await sleep(20); f.change('park', false); await sleep(20);
  await sleep(500);
  assert.equal(f.payloads.slice(before).filter(p => p.agent === 'a').length, 1, 'two changes in one window: one sync');
  await f.idle(); await sleep(50);
  const mid = f.payloads.length;
  f.change('park', false); await sleep(20);
  const pausedAt = Date.now();
  f.change('park', true);  // a Pause while a spread sync (due at ≈396 ms) is pending
  await sleep(700);
  const after = f.payloads.map((p, i) => ({ p, t: f.syncTimes[i] - pausedAt })).slice(mid).filter(x => x.p.agent === 'a');
  // The Pause syncs at once; the pending spread sync is cancelled.
  assert.ok(after.length >= 1 && after.every(x => x.t < 300), `no sync after the window: ${after.map(x => Math.round(x.t)).join(', ')} ms`);
  assert.notEqual(after.at(-1).p.projectPauseRevision, undefined, 'the Pause is confirmed');
});

test('a member that stops while its spread sync is pending never syncs', async t => {
  const f = await setup(t, { onChangeSpreadMs: 400, turnMs: 3000, random: () => 0.99 });
  const a = await f.start('park', 'a');
  await f.start('park', 'b');
  await until(() => f.held.get('park'), n => n === 1, 'one hold');
  await sleep(500);
  f.change('park', false); await sleep(20);
  await f.stop(a);
  const stoppedAt = f.payloads.length;
  await sleep(600);
  assert.equal(f.payloads.slice(stoppedAt).filter(p => p.agent === 'a').length, 0, 'the stopped member does not sync');
  assert.ok(f.payloads.slice(stoppedAt).some(p => p.agent === 'b'), 'the other member still syncs');
});

test('missions started together tick at spread phases, not in the same instant every interval (C6-T)', async t => {
  // Draws per mission start: first periodic tick at 0.55, 0.685, 0.82 and 0.955 intervals after the immediate start tick.
  // The phase draw comes before any C6-S spread or failure back-off draw of that mission.
  const draws = [0, 0.3, 0.6, 0.9];
  const f = await setup(t, { observeIntervalMs: 800, random: () => draws.length ? draws.shift() : 0.5 });
  const started = Date.now();
  for (const agent of ['a', 'b', 'c', 'd']) await f.start('park', agent);
  await until(() => f.observeTimes.length, n => n >= 12, 'three ticks per mission');
  const byAgent = agent => f.observeTimes.filter(o => o.agent === agent).map(o => o.t - started);
  // Each mission's first periodic tick (its second observe) lands at its own phase, within [0.55, 1] intervals.
  const firsts = ['a', 'b', 'c', 'd'].map(agent => byAgent(agent)[1]).sort((x, y) => x - y);
  for (let i = 1; i < firsts.length; i++) assert.ok(firsts[i] - firsts[i - 1] >= 60, `phases ${firsts.join(', ')} ms are spread`);
  for (const agent of ['a', 'b', 'c', 'd']) {
    const [start, first, second] = byAgent(agent);
    assert.ok(first - start >= 440 - 20 && first - start <= 800 + 200, `${agent}: first gap within 0.55 to one interval (${first - start} ms)`);
    // The phase is drawn once: afterwards ticks are one interval apart, not re-aligned or re-drawn.
    assert.ok(Math.abs(second - first - 800) < 200, `${agent} keeps its phase (${first}, ${second})`);
  }
});

// Holder handover acceptance (c3): revoked, superseded and stopping holders, with the remaining members' fences.
const holderOf = f => f.holders.at(-1).split('/')[1];

test('a superseded holder hands over at once; a later Pause reaches every remaining member and never the superseded one', { timeout: 10000 }, async t => {
  const f = await setup(t);
  for (const agent of ['a', 'b', 'c']) await f.start('park', agent);
  await until(() => f.held.get('park'), n => n === 1, 'one hold');
  f.change('park', false);
  await until(() => f.afters.at(-1), r => r === 1, 'holding at revision 1');
  const superseded = holderOf(f), from = f.holders.length;
  f.refusals.set(superseded, { error: { code: 'run_superseded' } });
  f.timeout('park');
  await until(() => f.holders.slice(from), h => h.some(x => x !== `park/${superseded}`), 'another member holds');
  assert.equal(f.afters.at(-1), 1, 'the successor carries the group revision');
  const before = f.payloads.length;
  f.change('park', true);
  const remaining = ['a', 'b', 'c'].filter(agent => agent !== superseded);
  for (const agent of remaining)
    await until(() => f.payloads.slice(before), p => p.some(x => x.agent === agent && x.projectPauseRevision === 2), `member ${agent} confirmed Pause`);
  await sleep(40);
  // The superseded mission's fence: no later session report and no later hold under its identity.
  assert.equal(f.payloads.slice(before).some(x => x.agent === superseded), false);
  assert.equal(f.holders.slice(from + 1).includes(`park/${superseded}`), false);
  await until(() => f.held.get('park'), n => n === 1, 'exactly one hold');
});

test('a change concurrent with the holder\'s stop reaches every remaining member', { timeout: 10000 }, async t => {
  const f = await setup(t);
  const missions = new Map();
  for (const agent of ['a', 'b', 'c']) missions.set(agent, await f.start('park', agent));
  // Every member has reported once and joined the group (joining follows the first report).
  await until(() => f.payloads, p => ['a', 'b', 'c'].every(agent => p.some(x => x.agent === agent)), 'every member reported');
  await sleep(20);
  await until(() => f.held.get('park'), n => n === 1, 'one hold');
  const holder = holderOf(f), before = f.payloads.length, from = f.holders.length;
  // The change races the stop: either the stopping holder delivers it, or its hold is cancelled and the successor's
  // hold at the old revision returns it at once. (An ended holder dropping an already resolved answer needs the stop to
  // land in the same turn as the answer, which this fake cannot force.)
  const stopping = f.stop(missions.get(holder));
  f.change('park', true);
  await stopping;
  for (const agent of ['a', 'b', 'c'].filter(x => x !== holder))
    await until(() => f.payloads.slice(before), p => p.some(x => x.agent === agent && x.projectPauseRevision === 1), `member ${agent} confirmed Pause`);
  await until(() => f.held.get('park'), n => n === 1, 'exactly one hold');
  assert.equal(f.holders.slice(from).includes(`park/${holder}`), false, 'the stopped holder never held again');
  // The successor holds from a known group revision, never from none (which would be first-answer semantics).
  assert.ok(Number.isSafeInteger(f.afters[from]), JSON.stringify(f.afters.slice(from)));
});

test('when every member is revoked in turn, each holds at most once more and the group stops holding', { timeout: 10000 }, async t => {
  const f = await setup(t);
  const agents = ['a', 'b', 'c', 'd'];
  for (const agent of agents) await f.start('park', agent);
  await until(() => f.held.get('park'), n => n === 1, 'one hold');
  const from = f.holders.length;
  for (const agent of agents) f.refusals.set(agent, { error: { code: 'forbidden', fatal: true } });
  f.timeout('park');
  await until(() => f.held.get('park') === 0 && f.holders.length - from >= agents.length, x => x, 'every member refused once');
  await sleep(100);
  // At most one refused attempt per member: no rotation loop, and nobody holds afterwards.
  const attempts = f.holders.slice(from);
  assert.ok(attempts.length <= agents.length, JSON.stringify(attempts));
  assert.equal(new Set(attempts).size, attempts.length);
  assert.equal(f.held.get('park'), 0);
  // The emptied group is gone: a later member starts a fresh hold from no revision, not the refused group's.
  const fresh = f.afters.length;
  await f.start('park', 'e');
  await until(() => f.held.get('park'), n => n === 1, 'the fresh member holds');
  assert.equal(f.afters[fresh], undefined);
});

test('revoking a holder on one site leaves the other site and another project untouched', { timeout: 10000 }, async t => {
  const f = await setup(t);
  await f.start('park', 'a'); await f.start('park', 'b');
  await f.start('park', 'x', 'https://other.invalid'); await f.start('park', 'y', 'https://other.invalid');
  await f.start('garden', 'g');
  const other = 'https://other.invalid|park';
  await until(() => [f.held.get('park'), f.held.get(other), f.held.get('garden')], h => h.every(n => n === 1), 'one hold per site and project');
  const holder = f.holders.filter(h => h === 'park/a' || h === 'park/b').at(-1).split('/')[1];
  f.refusals.set(holder, { error: { code: 'unauthorized', fatal: true } });
  f.timeout('park');
  await until(() => f.holders.at(-1), last => last === `park/${holder === 'a' ? 'b' : 'a'}`, 'site one handed over');
  assert.equal(f.held.get(other), 1); assert.equal(f.held.get('garden'), 1);
  const before = f.payloads.length;
  f.change(other, true); f.change('garden', true);
  await until(() => f.payloads.slice(before), p => ['x', 'y', 'g'].every(agent => p.some(x => x.agent === agent && x.projectPauseRevision === 1)), 'other site and project paused');
  await sleep(40);
  assert.equal(f.payloads.slice(before).some(x => (x.agent === 'a' || x.agent === 'b') && x.projectPauseRevision !== undefined), false, 'site one never paused');
});

test('the last member leaving ends the group; a later member starts one fresh hold with the current state', { timeout: 10000 }, async t => {
  const f = await setup(t);
  const a = await f.start('park', 'a'), b = await f.start('park', 'b');
  await until(() => f.held.get('park'), n => n === 1, 'one hold');
  await f.stop(a); await f.stop(b);
  await until(() => f.held.get('park'), n => n === 0, 'no hold');
  const calls = f.calls.length;
  f.change('park', true);
  await sleep(60);
  assert.equal(f.calls.length, calls, 'nobody holds for an empty group');
  const from = f.afters.length;
  await f.start('park', 'c');
  await until(() => f.payloads, p => p.some(x => x.agent === 'c' && x.projectPauseRevision === 1), 'the new member confirms the current Pause');
  assert.equal(f.afters[from], undefined, 'a fresh group holds from no revision');
  await until(() => f.held.get('park'), n => n === 1, 'one hold');
  f.change('park', false);
  await until(() => f.afters.at(-1), r => r === 2, 'the fresh hold follows later changes');
});

test('a member whose first report predates a change confirms it when it joins the group, not a tick later', { timeout: 10000 }, async t => {
  let fired = false, f;
  // The change lands just after c's first session report and before c joins: c reported without it, and the group
  // already holds the newer state that c applies when it joins.
  f = await setup(t, { onSession: agent => { if (agent === 'c' && !fired) { fired = true; f.change('park', true); } } });
  await f.start('park', 'a'); await f.start('park', 'b');
  await until(() => f.held.get('park'), n => n === 1, 'one hold');
  await f.start('park', 'c');
  await until(() => f.payloads, p => ['a', 'b'].every(agent => p.some(x => x.agent === agent && x.projectPauseRevision === 1)), 'a and b confirmed');
  // observeIntervalMs is 10 s, so only a sync on joining can confirm within this wait.
  await until(() => f.payloads, p => p.some(x => x.agent === 'c' && x.projectPauseRevision === 1), 'c confirmed Pause after joining');
});

// Owner decision, 10 November 2026 ("Short last turn"): after a project Pause, an agent whose latest turn was work
// gets one short turn that only posts an update. The Pause is confirmed when that turn ends.
const pauseUpdates = f => f.runs.filter(r => r.pauseUpdate).length;
const confirmed = (f, from) => f.payloads.slice(from).some(p => p.projectPauseRevision !== undefined);

test('a project Pause gives an agent that worked one pause update turn, confirmed after it and not repeated', async t => {
  const f = await setup(t, { turnMs: 300 });
  await f.start('park', 'a');
  await until(() => f.runs.length, n => n === 1, 'the first work turn');
  const from = f.payloads.length;
  f.change('park', true);
  await until(() => pauseUpdates(f), n => n === 1, 'one pause update turn');
  await until(() => confirmed(f, from), Boolean, 'Pause confirmed after the update turn');
  await f.idle();
  f.timeout('park'); await sleep(200);
  assert.equal(pauseUpdates(f), 1, 'no second update turn while still paused');
  // After Resume and more work, the next Pause gives one more.
  f.change('park', false);
  await until(() => f.runs.filter(r => !r.pauseUpdate).length, n => n >= 2, 'work resumes');
  await sleep(50);
  f.change('park', true);
  await until(() => pauseUpdates(f), n => n === 2, 'one update turn for the second Pause');
});

test('an agent paused on its own gets no pause update turn when the project pauses', async t => {
  const f = await setup(t);
  const mission = await f.start('park', 'a');
  await until(() => f.runs.length, n => n === 1, 'the first work turn');
  await f.pause(mission); await sleep(50);
  const from = f.payloads.length;
  f.change('park', true);
  await sleep(300);
  assert.equal(pauseUpdates(f), 0);
  assert.equal(f.runs.length, 1);
  assert.ok(from <= f.payloads.length);
});

test('an agent at its token cap gets no pause update turn', async t => {
  const f = await setup(t, { tokenLimit: { tokens: 100, othersUsed: 0 }, usage: { tokens: { input: 150, output: 10 } } });
  await f.start('park', 'a');
  await until(() => f.runs.length, n => n === 1, 'the turn that crosses the cap');
  await sleep(50);
  const from = f.payloads.length;
  f.change('park', true);
  await until(() => confirmed(f, from), Boolean, 'Pause confirmed at once');
  await sleep(100);
  assert.equal(pauseUpdates(f), 0);
});
