import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listenerCapShape, queuedReadsPerAnswer, listenerCpuCores, ACCESS_READS, accessReadsPerAnswer, gate1Designs, SESSION_ROW_BYTES_SYNTHETIC_JSON, captureCalls, FULL_MAP_BY_READER, captureUnits, changeRate, compareShape, hintsPerAnswerBreakEven, matchedReplay, matchedReplayAlternatives, LAB_TRANSITIONS, labTransitionRange, listenerServed, month6, perTabSweep, projectionDelta, push, slotSweep, type Load } from './current-state-model.js';
import { WORKBOOK, SEGMENTS } from './capacity-shapes.js';

const minute: Load = { changesPerAgentS: 1 / 60, pollS: 3, projectionWritePerChange: 1 };
const r = (x: number) => Math.round(x);

test('sweeps tie freshness to roster size; delta and push tie it to the poll interval or the listener', () => {
  for (const agents of [5, 500, 5000]) {
    const shape = { agents, viewers: 10, instances: 10 };
    assert.equal(projectionDelta(shape, minute, true).freshnessS, 3);
    assert.equal(push(shape, minute).freshnessS, 1);
  }
  // 5,000 agents: a full sweep pass is 252 s (per tab) or 192 s (S3 v2), plus a slot.
  assert.equal(perTabSweep({ agents: 5000, viewers: 1, instances: 1 }).freshnessS, 255);
  assert.equal(slotSweep({ agents: 5000, viewers: 1, instances: 1 }).freshnessS, 195);
});

test('delta and push work scales with changes and reached processes, not agents × viewers per tick', () => {
  const quiet: Load = { ...minute, changesPerAgentS: 0 };
  // With no changes, a shared delta query costs one empty read per process per poll plus each viewer's poll overhead.
  const idle = projectionDelta({ agents: 5000, viewers: 100, instances: 59 }, quiet, true);
  assert.ok(idle.readsPerS < 300);
  assert.ok(perTabSweep({ agents: 5000, viewers: 100, instances: 59 }).readsPerS > 8000);
  // Doubling the viewers of a shared-delta flagship adds only the per-poll overhead once every process is reached.
  const a = projectionDelta({ agents: 5000, viewers: 100, instances: 59 }, minute, true);
  const b = projectionDelta({ agents: 5000, viewers: 200, instances: 59 }, minute, true);
  assert.ok(b.readsPerS - a.readsPerS < 0.2 * a.readsPerS + 200 / 3 * 4);
  // Per-viewer delta scales with viewers; that is why the query must be shared (process-independent cursor).
  const pv = projectionDelta({ agents: 5000, viewers: 100, instances: 59 }, minute, false);
  assert.ok(pv.readsPerS > 2 * a.readsPerS);
});

test('the 5,000-agent hotspot at one change per agent per minute: fresher and cheaper than both sweeps', () => {
  const f = compareShape({ agents: 5000, viewers: 100, instances: 59 }, minute);
  assert.deepEqual([r(f.perTab.readsPerS), r(f.slot.readsPerS), r(f.deltaShared.readsPerS), r(f.push.readsPerS)], [8633, 5564, 4160, 4038]);
  assert.equal(r(f.deltaShared.writesPerS), 83);  // one projection write per change, unless folded into the source write
  assert.equal(f.push.heldStreams, 100);
});

test('the crossover: above about one change per agent every 20-40 s, a 3 s delta costs more reads than the 192 s sweep', () => {
  const at = (c: number) => compareShape({ agents: 5000, viewers: 100, instances: 59 }, { ...minute, changesPerAgentS: c });
  assert.ok(at(1 / 60).deltaShared.readsPerS < at(1 / 60).slot.readsPerS);
  assert.ok(at(1 / 20).deltaShared.readsPerS > at(1 / 20).slot.readsPerS);
  // So per-contact liveness (one stamp per 60 s) must not be a projected change on its own: project transitions and
  // let the client expire freshness from freshUntil.
});

test('month 6 (FM1 populations, 59 instances): map status reads by design', () => {
  const m = month6(minute);
  assert.deepEqual([r(m.perTab.readsPerS), r(m.slot.readsPerS), r(m.deltaShared.readsPerS), r(m.push.readsPerS)], [59439, 53866, 13759, 11789]);
  assert.equal(r(m.deltaShared.writesPerS), 608);
  assert.equal(r(m.push.heldStreams), 1530);
  // Held streams take a Cloud Run concurrency slot each (c7): 20 API instances at 80, or 3 on the control service at 750.
  assert.deepEqual(m.streamInstances, { api: 20, control: 3 });
});

test('liveness decides the cost (c1): counting every 20 s sync as a change erases most of the saving', () => {
  const t = 1 / 600;  // one state transition per agent per 10 min (placeholder until the lab trace is counted)
  const at = (liveness: Parameters<typeof changeRate>[1]) => month6({ changesPerAgentS: changeRate(t, liveness), pollS: 3, projectionWritePerChange: 1 });
  const everySync = at('every-sync'), extended = at('every-contact'), transitions = at('transitions-only');
  assert.deepEqual([r(everySync.deltaShared.readsPerS), r(extended.deltaShared.readsPerS), r(transitions.deltaShared.readsPerS)], [38088, 14917, 3457]);
  assert.deepEqual([r(everySync.deltaShared.writesPerS), r(extended.deltaShared.writesPerS), r(transitions.deltaShared.writesPerS)], [1886, 669, 61]);
  // every-sync and every-contact keep 3 s freshness and the 90 s Offline bound; the slot sweep keeps 195 s at 53,866 reads/s.
  // transitions-only drops the Offline bound (c4, codex-1), so it is a reference row, not a default.
  assert.ok(everySync.deltaShared.readsPerS < everySync.slot.readsPerS);
  // If presence/{id} is the status document (c1), the every-contact liveness write already exists (C4-10), so the
  // projection adds only the transition writes (61/s), not 669.
  // An owner lease choice: a 150 s Offline bound halves the liveness change rate (c4: writes ≈ A/(D − 30 s)).
  const lease = month6({ changesPerAgentS: changeRate(t, 'every-contact', 150), pollS: 3, projectionWritePerChange: 1 });
  assert.deepEqual([r(lease.deltaShared.readsPerS), r(lease.deltaShared.writesPerS)], [9125, 365]);
});

test('c1 2b: one tab open per viewer per hour adds ≈139 reads/s to the flagship query delta', () => {
  const at = (viewerOpenS?: number) => projectionDelta({ agents: 5000, viewers: 100, instances: 59 }, { ...minute, viewerOpenS }, true).readsPerS;
  assert.equal(r(at(3600) - at()), 139);
});

test('c2 contract (listener per project per process, served from memory): random routing sets the cost', () => {
  // Flagship: 100 viewers reach every instance within the 30 s linger, so all 59 keep a listener (E → I, not 48.7).
  const f = compareShape({ agents: 5000, viewers: 100, instances: 59 }, minute);
  assert.equal(r(f.listenerPoll.listeners), 59);
  assert.equal(r(f.listenerPoll.readsPerS), 5050);
  // A 200-agent project with 5 viewers keeps ≈34 listeners and re-attaches ≈0.7 per second, each reading all 200 agents.
  const mid = listenerServed({ agents: 200, viewers: 5, instances: 59 }, minute, 'poll');
  assert.deepEqual([r(mid.listeners), r(mid.attachesPerS * 10) / 10, r(mid.readsPerS)], [34, 0.7, 262]);
  assert.ok(mid.readsPerS > 10 * projectionDelta({ agents: 200, viewers: 5, instances: 59 }, minute, true).readsPerS);
  // Month 6, a freshUntil extension on every stored contact: on 59 API instances it costs ≈3× the shared commit-ordered query; served from a
  // 3-instance service it is the cheapest poll design. All are 3 s fresh against the slot sweep's 195 s at 53,866.
  const load: Load = { changesPerAgentS: changeRate(1 / 600, 'every-contact'), pollS: 3, projectionWritePerChange: 1 };
  const api = month6(load), few = month6(load, 3);
  assert.deepEqual([r(api.listenerPoll.readsPerS), r(api.deltaShared.readsPerS), r(few.listenerPoll.readsPerS)], [41993, 14917, 3958]);
});

test('lab-derived transition range (one agent, 30% busy): placement decides whether the API listener beats the sweep', () => {
  const [low, high] = labTransitionRange();
  const at = (t: number, instances?: number) => month6({ changesPerAgentS: changeRate(t, 'every-contact'), pollS: 3, projectionWritePerChange: 1 }, instances);
  const lo = at(low), hi = at(high), loFew = at(low, 3), hiFew = at(high, 3);
  assert.deepEqual([r(lo.listenerPoll.readsPerS), r(hi.listenerPoll.readsPerS)], [40600, 50860]);
  assert.deepEqual([r(loFew.listenerPoll.readsPerS), r(hiFew.listenerPoll.readsPerS)], [3866, 4541]);
  assert.deepEqual([r(lo.listenerPoll.writesPerS), r(hi.listenerPoll.writesPerS)], [637, 875]);
  // If every connected agent turned over like the short-turn lab window (one transition per 41 s, no idle share), the API listener
  // costs more than the slot sweep at month 6; a few-instance service still does not.
  const allBusy = at(1 / LAB_TRANSITIONS.busyShortS), allBusyFew = at(1 / LAB_TRANSITIONS.busyShortS, 3);
  assert.ok(allBusy.listenerPoll.readsPerS > allBusy.slot.readsPerS);
  assert.ok(allBusyFew.listenerPoll.readsPerS < 0.15 * allBusy.slot.readsPerS);
});

test('c9 W0 resync (4d0fdfe0) under random routing: team maps resync on most polls on 59 instances, almost never on 3', () => {
  const load: Load = { changesPerAgentS: changeRate(labTransitionRange()[0], 'every-contact'), pollS: 3, projectionWritePerChange: 1 };
  const team = (instances: number) => listenerServed({ agents: 50, viewers: 3, instances }, load, 'poll');
  assert.deepEqual([r(team(59).resetShare * 100), r(team(3).resetShare * 100)], [63, 0]);
  // Records sent per poll: ≈12× a plain delta on the API (full snapshots), unchanged on a few-instance service.
  assert.deepEqual([r(team(59).recordsPerRequest * 10) / 10, r(team(3).recordsPerRequest * 10) / 10], [32.6, 2.6]);
  // c9's simulation (c52953e8) at four shapes: model within 25% of the simulated resync share.
  const quiet: Load = { changesPerAgentS: 0, pollS: 3, projectionWritePerChange: 1 };
  for (const [agents, viewers, instances, linger, sim] of [[300, 6, 8, 5, 0.487], [200, 20, 59, 30, 0.059], [200, 5, 59, 30, 0.45], [40, 2, 12, 30, 0.203]])
    assert.ok(Math.abs(listenerServed({ agents, viewers, instances }, quiet, 'poll', linger).resetShare / sim - 1) < 0.25);
  // The 5,000-agent flagship keeps a listener everywhere, so its polls never resync.
  assert.equal(r(listenerServed({ agents: 5000, viewers: 100, instances: 59 }, load, 'poll').resetShare * 1000), 0);
});

test('gate 2 (worker freshness, c1/c6): every-sync changes cost less than S3 only on a few-instance service', () => {
  const [low, high] = labTransitionRange();
  const at = (t: number, liveness: Parameters<typeof changeRate>[1], instances?: number) =>
    month6({ changesPerAgentS: changeRate(t, liveness), pollS: 3, projectionWritePerChange: 1 }, instances).listenerPoll.readsPerS;
  // (a) worker summary in presence: every 20 s sync is a change.
  assert.deepEqual([r(at(low, 'every-sync', 3)), r(at(high, 'every-sync', 3))], [7309, 7984]);
  assert.deepEqual([r(at(low, 'every-sync')), r(at(high, 'every-sync'))], [92910, 103170]);
  // (b) the ≤60 s throttle (not equal freshness) for contrast.
  assert.deepEqual([r(at(low, 'every-contact', 3)), r(at(high, 'every-contact', 3))], [3866, 4541]);
});

test('listener-stall probe (c3, T = 10 s) under gate 2 (a): small projects only, a few reads per second at month 6', () => {
  const [low] = labTransitionRange();
  const load: Load = { changesPerAgentS: changeRate(low, 'every-sync'), pollS: 3, projectionWritePerChange: 1 };
  let probes = 0, bound = 0;
  for (const s of SEGMENTS) {
    const projects = Math.ceil(WORKBOOK.monthlyProjects[5][s] * WORKBOOK.peakFraction), v = WORKBOOK.viewersPerProject[s];
    const watched = v < 1 ? projects * v : projects;
    const d = listenerServed({ agents: WORKBOOK.sessionsPerProject[s], viewers: Math.max(1, v), instances: 3 }, load, 'poll');
    probes += watched * d.stallProbeReadsPerS; bound += watched * d.listeners / 10;
  }
  assert.deepEqual([r(probes), r(bound)], [9, 176]);
});

test('delta follow-ups (c1): under gate 2 (a) only the flagship overflows a 500-row page per 3 s poll', () => {
  const [low] = labTransitionRange();
  const load: Load = { changesPerAgentS: changeRate(low, 'every-sync'), pollS: 3, projectionWritePerChange: 1 };
  const flagship = listenerServed({ agents: 5000, viewers: 100, instances: 3 }, load, 'poll');
  // ≈762 rows per poll → one follow-up per poll: 100/3 × 4 ≈ 133 reads/s per flagship.
  assert.equal(r(flagship.followUpReadsPerS), 133);
  assert.equal(listenerServed({ agents: 500, viewers: 15, instances: 3 }, load, 'poll').followUpReadsPerS, 0);
  // The stall probe at 2 reads (c3's interim probe) doubles that term.
  const team = (probeReads: number) => listenerServed({ agents: 5, viewers: 1, instances: 3 }, load, 'poll', undefined, undefined, probeReads).stallProbeReadsPerS;
  assert.equal(r(team(2) / team(1)), 2);
});

test("codex-1's matched replay (ca31cd9a) decomposes exactly: five full captures are the fixed cost; calls are per-doc gets", () => {
  assert.equal(captureUnits(20), 107);
  assert.equal(captureCalls(20), 88);
  const counted = [1, 4, 20].map(v => matchedReplay(v));
  assert.deepEqual(counted.map(m => [m.full.units, m.shared.units]), [[584, 583], [2336, 655], [11680, 1039]]);
  assert.deepEqual(counted.map(m => [m.full.calls, m.shared.calls]), [[128, 488], [440, 560], [2104, 944]]);
  // Projection, not measured: the same capture with two tx.getAll calls instead of 80 tx.get calls.
  assert.equal(captureCalls(20, true), 10);
  assert.deepEqual([1, 4, 20].map(v => matchedReplay(v, true).shared.calls), [98, 170, 554]);
  // Units tie at one viewer because 5 hints / 8 answers is just under the break-even.
  assert.equal(Math.round(hintsPerAnswerBreakEven() * 100) / 100, 0.65);
  assert.equal(captureUnits(5000), 25505);
});

test("c9's oracle bound on ca31cd9a: a capture every round, or a listener on a complete projection or on today's sources (derived)", () => {
  const alt = [1, 4, 20].map(v => matchedReplayAlternatives(v));
  assert.deepEqual(alt.map(a => a.captureEveryRound), [904, 976, 1360]);  // c9's figures; full map 584/2336/11680
  assert.deepEqual(alt.map(a => a.completeProjection.units), [111, 183, 567]);  // needs projection writers not built
  assert.equal(alt[0]!.completeProjection.projectionWrites, 11);
  assert.deepEqual(alt.map(a => a.todaysSources.units), [287, 359, 743]);  // c9's all-sources variant
});

test('reset paging (c1): small next to the attach that causes it; zero for a 100-viewer flagship', () => {
  const [low] = labTransitionRange();
  const load: Load = { changesPerAgentS: changeRate(low, 'every-sync'), pollS: 3, projectionWritePerChange: 1 };
  // One viewer on a 5,000-agent project over 59 instances: 86% of requests reset, 9 extra pages each.
  const lone = listenerServed({ agents: 5000, viewers: 1, instances: 59 }, load, 'poll');
  assert.deepEqual([r(lone.resetShare * 100), r(lone.resetPagingReadsPerS), r(lone.readsPerS)], [86, 10, 3744]);
  assert.equal(r(listenerServed({ agents: 5000, viewers: 100, instances: 59 }, load, 'poll').resetPagingReadsPerS), 0);
  assert.equal(listenerServed({ agents: 500, viewers: 15, instances: 3 }, load, 'poll').resetPagingReadsPerS, 0);
});

test("idle re-attach (c2 v2.3 point 5 (a)) priced per T at month 6, and c2 core row visits for the flagship", () => {
  const [low] = labTransitionRange();
  const load: Load = { changesPerAgentS: changeRate(low, 'every-sync'), pollS: 3, projectionWritePerChange: 1 };
  const month = (T: number, instances: number) => {
    let reads = 0;
    for (const s of SEGMENTS) {
      const projects = Math.ceil(WORKBOOK.monthlyProjects[5][s] * WORKBOOK.peakFraction), v = WORKBOOK.viewersPerProject[s];
      const watched = v < 1 ? projects * v : projects;
      const d = listenerServed({ agents: WORKBOOK.sessionsPerProject[s], viewers: Math.max(1, v), instances }, load, 'poll', undefined, undefined, 1, T);
      reads += watched * d.idleReattachReadsPerS;
    }
    return r(reads);
  };
  // Every-sync liveness moves W every ≈20 s per agent, so connected projects almost never idle past 30 s.
  assert.deepEqual([10, 30, 60].map(T => month(T, 3)), [46, 0, 0]);
  assert.deepEqual([10, 30, 60].map(T => month(T, 59)), [145, 0, 0]);
  // Not in FM1's populations: a watched project with no connected agent never moves W, so it re-attaches every T.
  // Its share of watched projects is unknown, not zero, until lab calibration supplies it (c1).
  const dead = listenerServed({ agents: 5, viewers: 1, instances: 3 }, { ...load, changesPerAgentS: 0 }, 'poll');
  assert.equal(Math.round(dead.idleReattachReadsPerS * 100) / 100, 1.45);  // ≈2.9 listeners × 5 reads / 10 s
  const f = listenerServed({ agents: 5000, viewers: 100, instances: 3 }, load, 'poll');
  assert.equal(r(f.rowVisitsPerS), 166667);  // 33 requests/s × 5,000 docs: CPU work, not billed reads
});

test('full-map baseline by reader (c1): integration default 93 per answer, not ca31 composite 73', () => {
  assert.deepEqual([1, 4, 20].map(v => matchedReplay(v, false, FULL_MAP_BY_READER.integrationDefault).full.units), [744, 2976, 14880]);
  assert.deepEqual([1, 4, 20].map(v => matchedReplay(v).full.units), [584, 2336, 11680]);
});

test('indexed core (c2 c25aff83, c9): delta visits k·⌈k/P⌉, so the flagship drops from ≈166,667 to ≈50,800 visits/s', () => {
  const [low] = labTransitionRange();
  const load: Load = { changesPerAgentS: changeRate(low, 'every-sync'), pollS: 3, projectionWritePerChange: 1 };
  const f = listenerServed({ agents: 5000, viewers: 100, instances: 3 }, load, 'poll');
  // ≈762 changes per 3 s poll → 2 pages → ≈1,524 visits per request × 33 requests/s.
  // Every-sync agents write once per ≈20 s, so ≈762 changes are 762 distinct ids → 2 pages → 1,524 visits per request.
  assert.equal(r(f.indexedRowVisitsPerS / 100) * 100, 50800);
  assert.equal(r(f.rowVisitsPerS), 166667);
  // One pass with a per-delta log cursor (c6 point 5): k + pages ≈ 764 per request.
  assert.equal(r(f.onePassRowVisitsPerS / 100) * 100, 25500);
});

test('gate 1 designs on their own contracts (c6, c7 c0b1413a): pinned sessions need affinity; head-only pays k·⌈k/P⌉ visits', () => {
  const [low] = labTransitionRange();
  const load: Load = { changesPerAgentS: changeRate(low, 'every-sync'), pollS: 3, projectionWritePerChange: 1 };
  const flagship = { agents: 5000, viewers: 100, instances: 3 };
  const [random, continuation, viewer] = (['random', 'continuation', 'viewer'] as const).map(routing => gate1Designs(flagship, load, { routing, maxSessions: 64 }));
  // (a) head-only: 15,000 rows of state ≈ 1.9 MB per process; ≈50,800 visits/s; routing-independent.
  assert.deepEqual([r(viewer.headOnly.memoryBytes / 1e3), r(viewer.headOnly.visitsPerS / 100) * 100], [1875, 50800]);
  assert.deepEqual(random.headOnly, viewer.headOnly);
  // (b) full viewer affinity: all 64 slots stay full of ≈762-row delta sessions (c7): ≈6.7 MB with the records,
  // ≈25,500 visits/s, plus one 5,000-row re-bootstrap per viewer per handoff (1 h default: ≈0.03/s).
  assert.deepEqual([r(viewer.pinnedSessions.memoryBytes / 1e5) / 10, r(viewer.pinnedSessions.visitsPerS / 100) * 100], [6.7, 25500]);
  // ≈11 multi-page answers/s per process → a slot lives ≈5.8 s; a slower continuation restarts with a first read.
  assert.equal(r(viewer.pinnedSessions.slotLifetimeS * 10) / 10, 5.8);
  assert.equal(r(viewer.pinnedSessions.resyncsPerS * 1000) / 1000, 0.028);
  // A reconnect wave leaves completed 5,000-row bootstrap sessions resident (c7): 33 viewers per process under affinity
  // ≈ 21 MB, and the 64-slot cap ≈ 40 MB under random-delta routing, before JS heap overhead.
  assert.deepEqual([r(viewer.pinnedSessions.bootstrapWaveBytes / 1e6), r(continuation.pinnedSessions.bootstrapWaveBytes / 1e6)], [21, 40]);
  // (b) sticky continuations, deltas random (c7's 14/16 mode): 2/3 of polls are cold first reads of 5,000 rows, so
  // ≈119,600 visits/s and up to 64 sessions × ≈3,600 rows (≈29 MB) per process. Completes, at a high price.
  assert.deepEqual([r(continuation.pinnedSessions.visitsPerS / 100) * 100, r(continuation.pinnedSessions.memoryBytes / 1e6)], [119600, 29]);
  assert.equal(continuation.pinnedSessions.multiPageCompletes, 1);
  // (b) no affinity: a 10-page bootstrap completes with probability (1/3)^9 ≈ 0.00005 (c7: 5/16, never completes).
  assert.equal(r(random.pinnedSessions.resyncsPerS * 10) / 10, 22.2);
  assert.ok(random.pinnedSessions.multiPageCompletes < 1e-4);
  assert.equal(r(viewer.pinnedSessions.replayEntries), 15234);  // 60 s gap at ≈254 changes/s
  // c1's FIFO livelock: steady in-flight ≈11/s × 1 extra page × 0.3 s ≈ 3.3 ≪ 64 slots, safe. A wave of 100 viewers
  // landing on one process (a handoff, or no affinity) exceeds 64 and completes nothing until the prototype keeps
  // in-progress sessions (refuse new or evict newest; codex-1's fix).
  assert.equal(r(viewer.pinnedSessions.inFlight * 10) / 10, 3.3);
  // Today's FIFO prototype: 33 viewers per process stay under 64 slots; a concentrated 100-viewer wave livelocks.
  assert.deepEqual(viewer.pinnedSessions.fifoLivelockToday, { steady: false, wave: false });
  assert.deepEqual(gate1Designs(flagship, load, { routing: 'viewer', maxSessions: 64, waveViewers: 100 }).pinnedSessions.fifoLivelockToday, { steady: false, wave: true });
  // At c1's ≈254 B JSON per synthetic row (heap unmeasured), 64 bootstrap sessions ≈ 81 MB of JSON per process.
  assert.equal(r(64 * 5000 * SESSION_ROW_BYTES_SYNTHETIC_JSON / 1e6), 81);
});

test("c3's v2.3 endpoint (e8a68b55): per-answer access reads and held-row derivations, flagship and month 6", () => {
  const [low] = labTransitionRange();
  const load: Load = { changesPerAgentS: changeRate(low, 'every-sync'), pollS: 3, projectionWritePerChange: 1 };
  const f = listenerServed({ agents: 5000, viewers: 100, instances: 3 }, load, 'poll');
  // 33 answers/s × ≈7.97 reads ≈ 266 reads/s, against the listener's ≈895 (+30%); 333,333 derivations/s of CPU.
  assert.deepEqual([r(f.accessReadsPerS), r(f.readsPerS), r(f.heldDerivationsPerS)], [266, 895, 333333]);
  let access = 0, base = 0;
  for (const s of SEGMENTS) {
    const projects = Math.ceil(WORKBOOK.monthlyProjects[5][s] * WORKBOOK.peakFraction), v = WORKBOOK.viewersPerProject[s];
    const watched = v < 1 ? projects * v : projects;
    const d = listenerServed({ agents: WORKBOOK.sessionsPerProject[s], viewers: Math.max(1, v), instances: 3 }, load, 'poll');
    access += watched * d.accessReadsPerS; base += watched * d.readsPerS;
  }
  assert.deepEqual([r(access), r(base)], [3480, 7309]);
});

test('per-answer authority reads grow with distinct owners (c1): 3d + 2; a 50-owner flagship pays ≈5,117 reads/s', () => {
  assert.deepEqual([accessReadsPerAnswer(1, true), accessReadsPerAnswer(1, false)], [ACCESS_READS.owner, ACCESS_READS.member]);
  const [low] = labTransitionRange();
  const load: Load = { changesPerAgentS: changeRate(low, 'every-sync'), pollS: 3, projectionWritePerChange: 1 };
  const at = (owners: number) => r(listenerServed({ agents: 5000, viewers: 100, instances: 3, owners }, load, 'poll').accessReadsPerS);
  assert.deepEqual([at(1), at(50), at(500)], [266, 5117, 50067]);
});

test('incomplete-doc re-read (c3, c10): before the CS2a writers the endpoint re-reads the roster per answer', () => {
  const [low] = labTransitionRange();
  const load: Load = { changesPerAgentS: changeRate(low, 'every-sync'), pollS: 3, projectionWritePerChange: 1 };
  const at = (share: number) => listenerServed({ agents: 5000, viewers: 100, instances: 3 }, load, 'poll', undefined, undefined, 1, undefined, share);
  // Flagship today (all docs incomplete): 33 answers/s × 5,000 × 4.2 ≈ 700,000 reads/s, against the per-tab sweep's
  // ≈8,600 at 255 s freshness. After the writers: 0.
  assert.deepEqual([r(at(1).incompleteRereadReadsPerS), at(0).incompleteRereadReadsPerS], [700000, 0]);
  assert.equal(r(perTabSweep({ agents: 5000, viewers: 100, instances: 3 }).readsPerS), 8633);
});

test("c2's 52313372: delta pages count distinct ids and big deltas walk the ids, so a 50k-change reconnect is ≤ 2n + pages", () => {
  const [low] = labTransitionRange();
  // 50,000 changes since the cursor on 5,000 agents: ≈5,000 distinct ids, 10 pages, bound 2n + 10 = 10,010 (c9 measured 5,009).
  const load: Load = { changesPerAgentS: 10 / 3, pollS: 3, projectionWritePerChange: 1 };
  const f = listenerServed({ agents: 5000, viewers: 1, instances: 1 }, load, 'poll');
  assert.equal(r(f.indexedRowVisitsPerS * 3), 10010);  // per 3 s answer (resets ≈0 here)
  // The flagship at the lab rate: periodic writers, 762 distinct ids, 2 pages (c9).
  const g = listenerServed({ agents: 5000, viewers: 100, instances: 3 }, { changesPerAgentS: changeRate(low, 'every-sync'), pollS: 3, projectionWritePerChange: 1 }, 'poll');
  assert.equal(r(g.indexedRowVisitsPerS / 100) * 100, 50800);
});

test("design (b) after codex-1's never-evict repair (0fd7ba66): a reconnect wave drains in ⌈W/S⌉ × p rounds", () => {
  const [low] = labTransitionRange();
  const load: Load = { changesPerAgentS: changeRate(low, 'every-sync'), pollS: 3, projectionWritePerChange: 1 };
  const wave = (w: number) => gate1Designs({ agents: 5000, viewers: 100, instances: 3 }, load, { routing: 'viewer', maxSessions: 64, waveViewers: w }).pinnedSessions.waveDrainRounds;
  // 10-page bootstraps on 64 slots: 100 → 20 rounds, 500 → 80 (measured 122 at W=500, with 384/500 done). At a 0.3 s page
  // delay, connected viewers' multi-page deltas wait ≈6 s and ≈24 s; lower bounds.
  assert.deepEqual([wave(100), wave(500)], [20, 80]);
});

test('listener CPU (c11 d7b147cd, local Node): ≈32 µs per doc per snapshot; the flagship spans 0.16 to ≈41 cores per process', () => {
  // c11's two rosters reproduce: 180 snapshots × 5,000 / × 1,000 docs ≈ 28.8 s / 5.8 s per 90 s (measured 29.5 / 5.4).
  assert.deepEqual([r(listenerCpuCores(5000, 2) * 90 * 10) / 10, r(listenerCpuCores(1000, 2) * 90 * 10) / 10], [28.8, 5.8]);
  // Flagship, every-sync at the lab low rate: ≈254 changes/s. One snapshot a second → 0.16 core; one per commit → ≈41 cores.
  const [low] = labTransitionRange(), changes = 5000 * changeRate(low, 'every-sync');
  assert.deepEqual([r(listenerCpuCores(5000, 1) * 100) / 100, r(listenerCpuCores(5000, changes))], [0.16, 41]);
});

test("queued starts per answer (c3 6cb11137 vs c2 7cddc86d): per-owner chunks cost ≈417 reads at the flagship, one project query ≈1", () => {
  assert.deepEqual([queuedReadsPerAnswer(5000, 1, 'perOwner'), queuedReadsPerAnswer(5000, 1, 'project')], [417, 1]);
  assert.equal(queuedReadsPerAnswer(300, 1, 'perOwner'), 25);  // c3's 300-agent unit work: 34 vs ≈9 before
  // Flagship, 100 viewers polling every 3 s: ≈13,900 reads/s against ≈33.
  assert.deepEqual([r(100 / 3 * queuedReadsPerAnswer(5000, 1, 'perOwner')), r(100 / 3 * queuedReadsPerAnswer(5000, 1, 'project'))], [13900, 33]);
  let perOwner = 0, project = 0;
  for (const s of SEGMENTS) {
    const projects = Math.ceil(WORKBOOK.monthlyProjects[5][s] * WORKBOOK.peakFraction), v = WORKBOOK.viewersPerProject[s];
    const watched = v < 1 ? projects * v : projects, answers = Math.max(1, v) / 3;
    perOwner += watched * answers * queuedReadsPerAnswer(WORKBOOK.sessionsPerProject[s], 1, 'perOwner');
    project += watched * answers * queuedReadsPerAnswer(WORKBOOK.sessionsPerProject[s], 1, 'project');
  }
  assert.deepEqual([r(perOwner), r(project)], [34663, 510]);
});

test('listener cap (100 per process, no eviction): 100 and 1,000 small projects beside a hot one, hot arriving last', () => {
  const small = (k: number) => Array.from({ length: k }, () => ({ agents: 5, viewers: 1 }));
  const hot = { agents: 5000, viewers: 100 };
  const at = (k: number, instances: number) => listenerCapShape([...small(k), hot], instances);
  // 100 small + hot on 1 process: demand 101 > 100, so the hot project, arriving last, is starved: all its requests
  // fall back, which is half of all requests (its 100 viewers against 100 small projects' one each).
  const a = at(100, 1);
  assert.deepEqual([r(a.demandPerProcess), a.starvedProjects, r(a.fallbackShare * 100)], [101, 1, 50]);
  // 100 small + hot on 3 processes: small projects hold w.p. ≈0.97 each, demand ≈98.4 ≤ 100, nobody starved.
  const b = at(100, 3);
  assert.deepEqual([b.saturated, b.starvedProjects], [false, 0]);
  // 1,000 small + hot on 3 processes: demand ≈975 per process, 899 projects (incl. the hot one) starved, 91% of requests.
  const c = at(1000, 3);
  assert.deepEqual([r(c.demandPerProcess), c.starvedProjects, r(c.fallbackShare * 100)], [975, 899, 91]);
  // Hot project first: it holds, and the starving moves to the small projects (82% of requests).
  const d = listenerCapShape([hot, ...small(1000)], 3);
  assert.deepEqual([d.starvedProjects, r(d.fallbackShare * 100)], [899, 82]);
  // More instances do not fix it: 1,000 small on 59 processes still demand ≈171 per process, 414 starved.
  const e = at(1000, 59);
  assert.deepEqual([r(e.demandPerProcess), e.starvedProjects], [171, 414]);
  // Re-attach churn (c9): on 59 processes a 1-viewer small project polls each process every ≈177 s, past the 33 s window,
  // so held ones re-attach almost every poll: 5 reads each. On 3 processes (every 9 s) churn is small.
  assert.deepEqual([r(e.reattachSeedReadsPerS * 10) / 10, r(c.reattachSeedReadsPerS * 100) / 100], [811.9, 4.35]);
});
