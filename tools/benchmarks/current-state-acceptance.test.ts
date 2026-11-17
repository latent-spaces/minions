import test from 'node:test';
import assert from 'node:assert/strict';
import { generateSchedule, simulate, type DesignName, type Schedule, type ScheduleOptions } from './current-state-acceptance.js';

// A small project (one sweep batch covers it) and a hotspot (300 agents, a scaled-down 5,000-agent map: one sweep
// pass takes 5 polls). Both have lagging commits (2% up to 20 s), deletions, revocations, private Needs you and two
// process restarts.
const SMALL: ScheduleOptions = { agents: 40, writes: 800, durationMs: 120_000, viewers: 12, instances: 3, people: 4,
  maxLagMs: 20_000, longLagFraction: 0.02, revokeFraction: 0.25, deleteFraction: 0.05, restarts: 2 };
const HOT: ScheduleOptions = { ...SMALL, agents: 300, writes: 3_000, viewers: 20, instances: 4, people: 6 };
const SEEDS = Array.from({ length: 12 }, (_, k) => 101 + k);
const correct = (r: ReturnType<typeof simulate>) =>
  ({ lost: r.lost, finalMismatch: r.finalMismatch, regressions: r.regressions, incompleteSnapshots: r.incompleteSnapshots, revocationLeaks: r.revocationLeaks, privacyLeaks: r.privacyLeaks });
const CLEAN = { lost: 0, finalMismatch: 0, regressions: 0, incompleteSnapshots: 0, revocationLeaks: 0, privacyLeaks: 0 };

test('sweep, log and push keep every viewer current, private and revoked on every seed', () => {
  for (const shape of [SMALL, HOT]) for (const seed of SEEDS) {
    const s = generateSchedule(seed, shape);
    for (const d of ['sweep', 'log', 'push'] as DesignName[])
      assert.deepEqual(correct(simulate(s, d, {}, seed)), CLEAN, `${d} seed ${seed} agents ${shape.agents}`);
  }
});

test('the stamp+overlap feed is correct only while commits lag their stamp by less than the overlap', () => {
  for (const seed of SEEDS) {
    const within = generateSchedule(seed, { ...HOT, maxLagMs: 9_000 });
    assert.deepEqual(correct(simulate(within, 'stamp', {}, seed)), CLEAN);
  }
  const lost = SEEDS.map(seed => simulate(generateSchedule(seed, HOT), 'stamp', {}, seed).lost);
  assert.ok(lost.some(n => n > 0), 'a 20 s commit lag must defeat a 10 s overlap');
});

test('a sequence allocated before commit loses entries; one assigned in commit order does not', () => {
  const lost = SEEDS.map(seed => simulate(generateSchedule(seed, HOT), 'log-prealloc', {}, seed).lost);
  assert.ok(lost.some(n => n > 0));
  // Compaction below a viewer's cursor forces explicit resyncs, never a silent gap.
  for (const seed of SEEDS.slice(0, 4)) {
    const s = generateSchedule(seed, HOT), kept = simulate(s, 'log', {}, seed), compacted = simulate(s, 'log', { retainMs: 2_000 }, seed);
    assert.deepEqual(correct(compacted), CLEAN);
    assert.ok(compacted.resyncs > kept.resyncs, `seed ${seed}: compaction must show up as resyncs`);
  }
});

test('push controls: a snapshot read before the listener attaches loses the commit in between', () => {
  // One viewer subscribes at 0; agent 0 commits at 100 ms, inside the 300 ms attach gap, and never again.
  const s: Schedule = { agents: 2, instances: 1, restarts: [], durationMs: 1_000, endMs: 60_000,
    viewers: [{ id: 0, person: 'p0', joinMs: 0, revokeMs: null }],
    commits: [{ i: 0, agent: 1, rev: 1, stampMs: 0, commitMs: 0, phase: 0, deleted: false, needsYouFor: null },
      { i: 1, agent: 0, rev: 1, stampMs: 90, commitMs: 100, phase: 1, deleted: false, needsYouFor: null }] };
  assert.equal(simulate(s, 'push').lost, 0);
  assert.equal(simulate(s, 'push-naive').lost, 1);
  assert.equal(simulate(s, 'push-naive').finalMismatch, 1);
});

test('push controls: streams must close on access loss and Needs you must be filtered per person', () => {
  const s = generateSchedule(SEEDS[0], HOT);
  assert.ok(simulate(s, 'push-noreauth').revocationLeaks > 0);
  assert.ok(simulate(s, 'push-leak').privacyLeaks > 0);
  assert.deepEqual(correct(simulate(s, 'push')), CLEAN);
});

test('freshness: push beats the sweep everywhere; the shared log matches it up to its sync coalescing', () => {
  for (const seed of SEEDS.slice(0, 4)) {
    const hot = generateSchedule(seed, HOT), small = generateSchedule(seed, SMALL);
    const sweepHot = simulate(hot, 'sweep', {}, seed), sweepSmall = simulate(small, 'sweep', {}, seed);
    // A 300-agent sweep pass takes 15 s; a delta or push read does not grow with the roster.
    assert.ok(simulate(hot, 'log', {}, seed).lagMs.p99 < sweepHot.lagMs.p50);
    assert.ok(simulate(hot, 'push', {}, seed).lagMs.p99 < sweepHot.lagMs.p50 / 10);
    // On a small map the sweep already reads everything every poll: the log may add at most its 250 ms coalescing.
    assert.ok(simulate(small, 'log', {}, seed).lagMs.max <= sweepSmall.lagMs.max + 250);
    assert.ok(simulate(small, 'push', {}, seed).lagMs.p99 < sweepSmall.lagMs.p50);
  }
});

test('work: sweep reads grow with viewers; push and the shared log grow with changes and processes', () => {
  const seed = SEEDS[0], few = generateSchedule(seed, HOT), many = generateSchedule(seed, { ...HOT, viewers: 80 });
  const ratio = (d: DesignName) => simulate(many, d, {}, seed).reads / simulate(few, d, {}, seed).reads;
  assert.ok(ratio('sweep') > 3, `sweep ×${ratio('sweep').toFixed(2)} for 4× viewers`);
  assert.ok(ratio('push') < 1.5, `push ×${ratio('push').toFixed(2)}`);
  assert.ok(ratio('log') < 1.5, `log ×${ratio('log').toFixed(2)}`);
  for (const d of ['log', 'push'] as DesignName[]) assert.ok(simulate(many, d, {}, seed).reads < simulate(many, 'sweep', {}, seed).reads / 3);
});

test('late, reordered and duplicated notifications never move a viewer back, and idle processes resync past compaction', () => {
  for (const seed of SEEDS.slice(0, 6)) {
    const s = generateSchedule(seed, { ...HOT, instances: 6 });
    // Up to 8 s notification delay with 30% duplicates; streams recycle every 5 s onto other, lagging processes.
    assert.deepEqual(correct(simulate(s, 'push', { notifyMaxMs: 8_000, duplicateFraction: 0.3, recycleMs: 5_000, accessCheckMs: 1_000 }, seed)),
      CLEAN, `push seed ${seed}`);
    // 8 processes and few viewers: a process often sits idle past a 2 s retention and must resnapshot.
    const idle = generateSchedule(seed, { ...HOT, instances: 8, viewers: 4 });
    assert.deepEqual(correct(simulate(idle, 'log', { retainMs: 2_000 }, seed)), CLEAN, `log seed ${seed}`);
  }
});

test("c2's watermark contract (C4/C5): cursor max(since, W) stays exact across lagging, lingering and restarted listeners", () => {
  for (const seed of SEEDS.slice(0, 6)) for (const shape of [HOT, { ...HOT, instances: 8, viewers: 6 }]) {
    const s = generateSchedule(seed, shape);
    for (const d of ['wm', 'wm-ids'] as DesignName[]) for (const lingerMs of [30_000, 5_000])
      assert.deepEqual(correct(simulate(s, d, { lingerMs }, seed)), CLEAN, `${d} seed ${seed} linger ${lingerMs}`);
  }
});

test('a cold replica cannot answer an older cursor from in-memory tombstones', () => {
  // Agent 0 is hard-deleted at 20 s; the only process restarts every second, so every later poll attaches after the
  // deletion and has no tombstone for it.
  const s: Schedule = { agents: 2, instances: 1, durationMs: 60_000, endMs: 70_000,
    restarts: Array.from({ length: 69 }, (_, k) => ({ instance: 0, atMs: 1_000 * (k + 1) })),
    viewers: [{ id: 0, person: 'p0', joinMs: 0, revokeMs: null }],
    commits: [{ i: 0, agent: 0, rev: 1, stampMs: 0, commitMs: 0, phase: 0, deleted: false, needsYouFor: null },
      { i: 1, agent: 1, rev: 1, stampMs: 0, commitMs: 0, phase: 0, deleted: false, needsYouFor: null },
      { i: 2, agent: 0, rev: 2, stampMs: 20_000, commitMs: 20_000, phase: 0, deleted: true, needsYouFor: null }] };
  assert.equal(simulate(s, 'wm-memtomb').finalMismatch, 1, 'the deleted agent stays on the map');
  for (const d of ['wm', 'wm-ids'] as DesignName[]) assert.deepEqual(correct(simulate(s, d)), CLEAN, d);
  const lost = SEEDS.map(seed => simulate(generateSchedule(seed, { ...HOT, instances: 8, viewers: 6 }), 'wm-memtomb', { lingerMs: 5_000 }, seed).lost);
  assert.ok(lost.some(n => n > 0));
});

test('watermark freshness follows the poll, not the roster; an id-set resync is cheaper than a full one', () => {
  for (const seed of SEEDS.slice(0, 4)) {
    const hot = generateSchedule(seed, HOT), small = generateSchedule(seed, SMALL);
    assert.ok(simulate(hot, 'wm', {}, seed).lagMs.p99 < simulate(hot, 'sweep', {}, seed).lagMs.p50);
    // Listener lag (≤ notifyMaxMs) plus one tick is the only addition over a small map's sweep.
    assert.ok(simulate(small, 'wm', {}, seed).lagMs.max <= simulate(small, 'sweep', {}, seed).lagMs.max + 500);
    const churn = generateSchedule(seed, { ...HOT, instances: 8, viewers: 6 });
    const full = simulate(churn, 'wm', { lingerMs: 5_000 }, seed), ids = simulate(churn, 'wm-ids', { lingerMs: 5_000 }, seed);
    assert.ok(ids.recordsSentPerViewer * 2 < full.recordsSentPerViewer, `seed ${seed}: ${ids.recordsSentPerViewer} vs ${full.recordsSentPerViewer}`);
  }
});

test('paged bootstrap: current heads by id from replicas at or past W_s give every agent at least its W_s revision', () => {
  // Pages of 10 with 100 ms between them, each on a random replica whose listener lags up to 3 s, while writes land.
  const stress = { notifyMaxMs: 3_000, pageSize: 10 };
  for (const seed of SEEDS.slice(0, 6)) for (const writes of [900, 6_000]) {
    const s = generateSchedule(seed, { ...HOT, writes, maxLagMs: 0, longLagFraction: 0 });
    assert.deepEqual(correct(simulate(s, 'wm-paged', stress, seed)), CLEAN, `seed ${seed} writes ${writes}`);
    // The CS2b core at 9c3f6ad6 keeps only docs committed by W_s on later pages: incomplete at W_s, healed by the delta.
    const filtered = simulate(s, 'wm-paged-filter', stress, seed);
    assert.ok(filtered.incompleteSnapshots > 0 && filtered.lost === 0, `seed ${seed}: filter`);
  }
  // Letting a replica behind W_s finish the page delivers older versions that no later delta repeats.
  const sparse = SEEDS.slice(0, 6).map(seed => simulate(generateSchedule(seed, { ...HOT, writes: 900, maxLagMs: 0, longLagFraction: 0 }), 'wm-paged-anyreplica', stress, seed));
  assert.ok(sparse.every(r => r.incompleteSnapshots > 0));
  assert.ok(sparse.reduce((n, r) => n + r.lost, 0) > 0, 'a lagging replica finishing the page loses final revisions');
});

test('runs replay exactly from their seeds', () => {
  const s = generateSchedule(5, HOT);
  for (const d of ['sweep', 'log', 'push', 'wm'] as DesignName[]) assert.deepEqual(simulate(s, d, {}, 5), simulate(generateSchedule(5, HOT), d, {}, 5));
});
