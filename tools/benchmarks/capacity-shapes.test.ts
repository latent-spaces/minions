import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { statusFeedPollsPerMinute, compareShapes, evaluateShape, evaluateForecast, keysPerProcess, authReuseHitRate, DEFAULT_ASSUMPTIONS } from './capacity-shapes.js';

test('equal 5000-session shapes cross different source bounds', () => {
  const [one, ten, hundred, thousand] = compareShapes();
  for (const r of [one, ten, hundred, thousand]) assert.equal(r.connected, 5000);
  assert.deepEqual(one.crossed, ['limiter_namespace_full', 'viewer_no_headroom', 'directory_truncated', 'map_sweep_cancelled']);
  assert.equal(one.viewer.mapPerMinute, 12 + 20 + 25 + 1);
  assert.equal(one.viewer.mapPerMinutePaced, 12 + 20 + 10 + 1);
  // The status feed: 64 blocks, a 192 s pass. By default a poll every active slot, 20/min, as the sweep (the quiet
  // 1×5,000 map stays ≈61/min with the header's 8 and one traffic read, over the 60/min budget). With the S3c stride
  // (owner opt-in; half the blocks 3 s later) 10/min, ≈51/min.
  assert.equal(one.viewer.feedPollsPerMinute, 20);
  assert.equal(one.viewer.mapPerMinuteFeed, 12 + 20 + 10 + 1);
  assert.equal(one.viewer.feedPollsPerMinuteStride, 10);
  assert.equal(one.viewer.mapPerMinuteFeedStride, 12 + 10 + 10 + 1);
  assert.deepEqual([5, 200, 400, 960, 5000].map(a => statusFeedPollsPerMinute(a)), [4, 8, 16, 20, 20]);
  assert.deepEqual([5, 200, 400, 960, 5000].map(a => statusFeedPollsPerMinute(a, true)), [4, 8, 12, 10, 10]);
  assert.equal(one.viewer.mapSweepRestartsToCoverAfterB1, 5);
  assert.equal(hundred.viewer.mapPerMinute, 12 + 4 + 1 + 1);
  // 59/min before any navigation: one click from the shared 60/min viewer budget.
  assert.equal(one.viewer.tasksPerMinute, 7 + 2 * (25 + 1));
  const crowded = evaluateShape({ projects: 1, sessionsPerProject: 5000 }, { ...DEFAULT_ASSUMPTIONS, membersPerProject: 500 });
  assert.equal(crowded.viewer.tasksPerMinute, 107);
  assert.ok(crowded.crossed.includes('viewer_budget'));
  assert.equal(crowded.viewer.tasksPerMinutePaced, 27);
  // c5: ten viewers polling usage for 5,000 agents read ~1,667 docs/s; coalesced, 500/s.
  const watched = evaluateShape({ projects: 1, sessionsPerProject: 5000 }, { ...DEFAULT_ASSUMPTIONS, viewersPerProject: 10 });
  assert.equal(Math.round(watched.usage.docReadsPerSecondNow), 1667);
  assert.equal(watched.usage.docReadsPerSecondCoalesced, 500);
  // U1: the same project reads a 65-record probe, 3 counts, 64 shards and the latest record per refresh.
  assert.equal(watched.usage.docReadsPerSecondAggregated, 14.5);
  assert.equal(evaluateShape({ projects: 10, sessionsPerProject: 500 }, { ...DEFAULT_ASSUMPTIONS, viewersPerProject: 1 }).usage.docReadsPerSecondAggregated, 133);
  const small = evaluateShape({ projects: 1000, sessionsPerProject: 5 }, { ...DEFAULT_ASSUMPTIONS, viewersPerProject: 1 }).usage;
  // Small projects keep the pre-U1 cost: the probe holds every record, plus the agent count: (5 + 1) / 10 per project.
  assert.equal(small.docReadsPerSecondAggregated, 600);
  assert.equal(one.viewer.mapSweepS, 249);
  // 500 agents already walk 25 directory pages twice a minute: 59 req/min.
  assert.deepEqual(ten.crossed, ['viewer_no_headroom']);
  assert.deepEqual(hundred.crossed, []);
  assert.deepEqual(thousand.crossed, ['router_cache_churn']);
});

test('boundary counts around the namespace cap and router cache', () => {
  assert.ok(!evaluateShape({ projects: 1, sessionsPerProject: 4999 }).crossed.includes('limiter_namespace_full'));
  assert.ok(evaluateShape({ projects: 1, sessionsPerProject: 5000 }).crossed.includes('limiter_namespace_full'));
  assert.ok(!evaluateShape({ projects: 100, sessionsPerProject: 5 }).routerCache.churn);
  assert.ok(evaluateShape({ projects: 101, sessionsPerProject: 5 }).routerCache.churn);
  assert.ok(!evaluateShape({ projects: 1, sessionsPerProject: 1200 }).viewer.mapSweepCancelledByRosterBaseline);
  // Matches README finding 2: the pure helper reached 1,200 agents before cancellation.
  assert.ok(evaluateShape({ projects: 1, sessionsPerProject: 1201 }).viewer.mapSweepCancelledByRosterBaseline);
});

test('limiter store overflows at 3C keys per process, whatever the shape', () => {
  // Idle or busy, a session holds wait, control and tools keys (the 20 s session sync uses the tool window), so
  // 6,000 sessions plus one viewer per project fit in 20,000 keys and 7,000 do not.
  assert.ok(!evaluateShape({ projects: 1000, sessionsPerProject: 6 }).limiter.storeOverflow);
  assert.ok(evaluateShape({ projects: 1000, sessionsPerProject: 7 }).limiter.storeOverflow);
  assert.ok(evaluateShape({ projects: 10, sessionsPerProject: 900 }).limiter.storeOverflow);
});

test('shared bindings cut held control, never below one binding per project', () => {
  const shared = { ...DEFAULT_ASSUMPTIONS, sessionsPerBinding: 10 };
  const one = evaluateShape({ projects: 1, sessionsPerProject: 5000 }, shared);
  const many = evaluateShape({ projects: 1000, sessionsPerProject: 5 }, shared);
  assert.equal(one.bindings, 500);
  assert.equal(many.bindings, 1000);
  assert.ok(one.control.mergedHeartbeatHeld < many.control.mergedHeartbeatHeld);
  assert.equal(one.control.currentHeld, 5000);
  assert.equal(one.control.mergedHeartbeatPerSecond, 5000 / 20 + 500 / 25);
});

test('shared listeners collapse to one per project; control rate is shape independent', () => {
  const [one, , , thousand] = compareShapes();
  assert.equal(one.control.currentPerSecond, 900);
  assert.equal(one.control.unchangedSyncSkippedPerSecond, 700);
  assert.equal(one.control.listenTargetsShared, 1);
  assert.equal(thousand.control.listenTargetsShared, 1000);
  assert.equal(one.control.largestProjectListeners, 5000);
});

test('retained revoked records multiply broadcast discovery work', () => {
  const r = evaluateShape({ projects: 1, sessionsPerProject: 50 }, { ...DEFAULT_ASSUMPTIONS, revokedPerProject: 50_000 });
  assert.deepEqual(r.broadcast, { invocationsNow: 126, invocationsLiveOnly: 1 });
});

test('invalid shapes are refused', () => {
  assert.throws(() => evaluateShape({ projects: 0, sessionsPerProject: 5 }));
  assert.throws(() => evaluateShape({ projects: 1.5, sessionsPerProject: 5 }));
});

test('four active computers exceed the shared owner budget of one person before any click', () => {
  const shape = { projects: 100, sessionsPerProject: 50 };
  assert.equal(evaluateShape(shape).owner.personPerMinute, 16);
  const four = evaluateShape(shape, { ...DEFAULT_ASSUMPTIONS, computersPerOwner: 4 });
  assert.equal(four.owner.personPerMinute, 64);
  assert.ok(four.crossed.includes('owner_budget'));
  assert.ok(!evaluateShape(shape, { ...DEFAULT_ASSUMPTIONS, computersPerOwner: 3 }).crossed.includes('owner_budget'));
});

// The workbook's frozen output (not a live model): rows of the Forecast and Infrastructure sheets from row 6.
const frozen = JSON.parse(readFileSync(new URL('./calculated-results.json', import.meta.url), 'utf8')) as
  { forecast: number[][]; infra: number[][] };
const row = (sheet: number[][], n: number) => sheet[n - 6];

test('forecast months reproduce the workbook populations they start from', () => {
  const months = evaluateForecast();
  assert.equal(months.length, 6);
  for (const [i, m] of months.entries()) {
    assert.equal(m.connected, row(frozen.forecast, 11)[i]);
    assert.equal(m.bindings, row(frozen.forecast, 13)[i]);
    assert.equal(m.viewers, row(frozen.forecast, 14)[i]);
    assert.equal(m.eventSessions, row(frozen.forecast, 33)[i]);
    assert.equal(m.eventBindings, row(frozen.forecast, 34)[i]);
    assert.equal(m.capacityTarget, row(frozen.forecast, 38)[i]);
    assert.equal(m.workbook.heartbeatPerSecond, row(frozen.infra, 6)[i]);
    assert.ok(Math.abs(m.workbook.renewalsPerSecond - row(frozen.infra, 7)[i]) < 1e-9);
    assert.ok(Math.abs(m.workbook.ownerPerSecond - row(frozen.infra, 8)[i]) < 1e-9);
    assert.ok(Math.abs(m.workbook.viewerPerSecond - row(frozen.infra, 11)[i]) < 1e-9);
  }
  // c4's held-control sizing: ⌈C/60⌉ API instances at concurrency 80.
  assert.deepEqual(months.map(m => m.control.heldApiInstances), [4, 113, 152, 335, 419, 609]);
});

test('counted control reads are several times the workbook unit work in every month', () => {
  for (const m of evaluateForecast()) {
    // 24/20 + 25/20 + 26/25 = 3.49 reads/s per idle session against at most 8/20 + 12/25 assumed.
    assert.ok(Math.abs(m.control.countedReadsPerSession - 3.49) < 1e-9);
    assert.ok(m.control.readsVsWorkbook > 4, `${m.month}: ${m.control.readsVsWorkbook}`);
  }
  const six = evaluateForecast()[5];
  assert.equal(Math.round(six.control.readsPerSecond), 127_385);
  // Idle control reads alone cost more per month than the workbook's whole Firestore read line (Infrastructure row 45).
  assert.ok(six.control.readsUsdPerMonth > row(frozen.infra, 45)[5]);
});

test('limiter keys: one process crosses 20,000 keys in month 2; random routing across held instances divides them', () => {
  const months = evaluateForecast();
  assert.ok(months[0].limiter.keysOneProcess < 20_000);
  assert.equal(months[1].limiter.keysOneProcess, 20_250);
  assert.deepEqual(months.map(m => m.limiter.instancesToFitStore), [1, 2, 3, 8, 10, 15]);
  for (const m of months) assert.ok(m.limiter.keysAtHeldInstances < 20_000 && !m.limiter.flagshipNamespaceFull);
  // With one process (or project affinity), a 5,000-session flagship fills its 5,000-key namespaces.
  assert.equal(keysPerProcess(5000, 1), 15_000);
  assert.ok(keysPerProcess(5000, 2) < 15_000 && keysPerProcess(5000, 2) > 12_000);
  assert.throws(() => keysPerProcess(1, 0));
});

test('owner and viewer request rates exceed the workbook proxies', () => {
  for (const m of evaluateForecast()) {
    // 32/3 req/min per active computer after C4-3 against one sync per 15 s.
    assert.ok(Math.abs(m.owner.vsWorkbook - 32 / 3 / 4) < 1e-9);
    assert.ok(m.viewer.vsWorkbook >= 3, `${m.month}: ${m.viewer.vsWorkbook}`);
  }
});

test('map status sweeps read per swept agent, far above the workbook viewer reads', () => {
  const months = evaluateForecast();
  // Small projects: 4 batches/min of 5 ids, (9 + 26) reads each, per viewer.
  for (const m of months) assert.ok(m.viewer.sweepReadsVsWorkbook > 1, `${m.month}: ${m.viewer.sweepReadsVsWorkbook}`);
  const six = months[5];
  // A 5,000-agent map tab sweeps 20 batches/min of 60 ids: 20/60 × (9 + 312) = 107 reads/s per visible viewer.
  const small = 4 / 60 * (9 + 5.2 * 5), team = 4 / 60 * (9 + 5.2 * 50), big = 20 / 60 * (9 + 5.2 * 60);
  assert.ok(Math.abs(six.viewer.mapSweepReadsPerSecond - (400 * small + 510 * team + 420 * big + 200 * big)) < 1e-6);
  assert.ok(six.viewer.sweepReadsVsWorkbook > 20);
});

test('the shared status feed: S3 saves most while instances are few, S3b shares a block across all of them (c2)', () => {
  const months = evaluateForecast();
  const at = (i: number) => months[i].viewer.statusFeed;
  // Inputs stay explicit: V per segment from the workbook, I = API instances after A1 (10 in month 2, 59 in month 6).
  assert.deepEqual([at(1).instances, at(5).instances], [10, 59]);
  const r = (x: number) => Math.round(x);
  assert.deepEqual([r(at(1).perTabReadsPerSecond), r(at(1).s3ReadsPerSecond), r(at(1).s3bReadsPerSecond)], [11_730, 3_137, 678]);
  assert.deepEqual([r(at(5).perTabReadsPerSecond), r(at(5).s3ReadsPerSecond), r(at(5).s3bReadsPerSecond), r(at(5).s3bWritesPerSecond)], [62_186, 53_866, 7_279, 48]);
  // The per-tab figure is the S2 sweep line (statusPerId − 1), and every month S3b ≤ S3 ≤ per tab.
  for (const m of months) {
    const f = m.viewer.statusFeed;
    assert.ok(f.s3bReadsPerSecond <= f.s3ReadsPerSecond && f.s3ReadsPerSecond <= f.perTabReadsPerSecond + 1e-9, m.month);
  }
  // A flagship's 100 viewers reach ≈48 of 59 instances, which is why S3 alone saves only ≈13% in month 6.
  assert.ok(Math.abs(59 * (1 - (58 / 59) ** 100) - 48.3) < 0.1);
  assert.ok(at(5).s3bUsdPerMonth < at(5).s3UsdPerMonth / 5);
});

test('the Tasks tab label walk reads about a sixth as much with the labels view (c2)', () => {
  const months = evaluateForecast(), r = (x: number) => Math.round(x);
  const six = months[5].viewer.tasksTab;
  assert.deepEqual([r(six.fullReadsPerSecond), r(six.labelsReadsPerSecond)], [24_381, 4_327]);
  // A flagship viewer: 10 pages a minute of 20 rows, (10 + 7.2·20) full against (7 + 20) labels.
  assert.ok(Math.abs(10 / 60 * (10 + 7.2 * 20) - 25.67) < 0.01 && Math.abs(10 / 60 * 27 - 4.5) < 1e-9);
  for (const m of months) assert.ok(m.viewer.tasksTab.labelsReadsPerSecond < m.viewer.tasksTab.fullReadsPerSecond / 4, m.month);
});

test('control transport options per month (c4 CT1 with counted reads)', () => {
  const months = evaluateForecast();
  for (const m of months) {
    const t = m.transport;
    // Shared holds (C4-7) hold one request per binding; reads keep the two 20 s polls per session.
    assert.equal(t.sharedHold.held, m.bindings);
    assert.ok(Math.abs(t.sharedHold.readsPerSecond - (m.connected * 49 / 20 + m.bindings * 16 / 25)) < 1e-6);
    assert.ok(Math.abs(t.mergedHeartbeat.readsPerSecond - (m.connected * 33 / 20 + m.bindings * 16 / 25)) < 1e-6);
    assert.ok(t.mergedHeartbeat.readsPerSecond < t.heartbeatPrototype.readsPerSecond && t.heartbeatPrototype.readsPerSecond < t.sharedHold.readsPerSecond
      && t.sharedHold.readsPerSecond < t.beforeSharedHold.readsPerSecond);
    // Even the merged heartbeat with today's per-request checks stays above the workbook's unit work.
    assert.ok(t.mergedHeartbeat.readsPerSecond > m.workbook.controlReadsPerSecond);
  }
  const six = months[5];
  assert.equal(six.bindings, 12_050);
  // The flag-off prototype as counted: 36,500 × 41/20 + 12,050 × 16/25.
  assert.equal(Math.round(six.transport.heartbeatPrototype.readsPerSecond), 82_537);
  // Counted merged fence after A1: 36,500 × 36/20 + 12,050 × 11/25.
  assert.equal(Math.round(six.transport.mergedFenceAfterA1.readsPerSecond), 71_002);
  assert.deepEqual([six.transport.heldServiceInstances, six.transport.apiOnlyHeldInstances], [17, 201]);
  // Capacity target in month 6 is the all-flagship event: 16,050 bindings.
  assert.deepEqual([six.transport.capacityTarget.bindings, six.transport.capacityTarget.heldServiceInstances, six.transport.capacityTarget.apiOnlyHeldInstances], [16_050, 22, 268]);
  assert.deepEqual(six.transport.recoveryReads, { serverSide: 12_050 * 16, connectorRestart: 12_050 * 27 });
});

test('broadcast task slices: request slices keep the queue light unless they fail', () => {
  const months = evaluateForecast();
  for (const [i, m] of months.entries()) assert.ok(Math.abs(m.delivery.slicesPerSecond - row(frozen.infra, 20)[i]) < 1e-9);
  const six = months[5];
  // 800·1 + 170·1 + 28·3 + 2·13 = 1,080 slices per 600 s = 1.8/s; the sending request runs one slice per broadcast.
  assert.ok(Math.abs(six.delivery.slicesPerSecond - 1.8) < 1e-9);
  assert.ok(Math.abs(six.delivery.queuedAfterRequestSlicePerSecond - (28 * 2 + 2 * 12) / 600) < 1e-9);
  assert.ok(six.delivery.burstQueueShareAfterRequestSlice < 0.2);
  // If request slices fail (API overloaded by held control), the 5× burst needs 9 dispatches/s against 4: month 5 is the
  // first over it (month 4 at 93%).
  assert.equal(months.findIndex(m => m.delivery.burstQueueShareIfRequestSlicesFail > 1), 4);
});

test('counted reads in total against the workbook read line (owner transport left out of both)', () => {
  for (const [i, m] of evaluateForecast().entries()) {
    // Workbook row 23 minus its owner-sync term (Infrastructure row 8 × 8 reads × 1.1 allowance) is reproduced exactly.
    assert.ok(Math.abs(m.totals.workbookReadsPerSecondWithoutOwner - (row(frozen.infra, 23)[i] - row(frozen.infra, 8)[i] * 8 * 1.1)) < 1e-6);
    assert.ok(m.totals.builtReadsPerSecond > 3 * m.totals.workbookReadsPerSecondWithoutOwner, m.month);
  }
  const six = evaluateForecast()[5];
  assert.ok(six.totals.todayReadsPerSecond > 200_000);
  assert.ok(six.totals.builtReadsPerSecond > 170_000);
});

test('with A1 and S2 the counted read line falls but stays above 2.5x the workbook', () => {
  for (const m of evaluateForecast()) {
    const t = m.totals;
    assert.ok(t.withA1AndS2ReadsPerSecond < t.builtReadsPerSecond, m.month);
    assert.ok(t.withA1AndS2ReadsPerSecond > 2.5 * t.workbookReadsPerSecondWithoutOwner, m.month);
  }
});

test('API compute from c9 local CPU: within about 1.5x of the workbook while reads are about 5x', () => {
  for (const [i, m] of evaluateForecast().entries()) {
    // The workbook's API instance row (Infrastructure 31) is reproduced from its own rows.
    assert.equal(m.compute.workbookApiInstances, row(frozen.infra, 31)[i]);
  }
  const six = evaluateForecast()[5];
  // 3,650 polls + 365 tool calls + 761 map-tab requests + 1,607 owner mailbox requests per second.
  assert.ok(Math.abs(six.compute.apiRequestsPerSecond - (3650 + 365 + six.viewer.map + 12_050 * 8 / 60)) < 1e-6);
  // ≈8 ms per request (c9's corrected figure; 5.7 ms lower bound): 86 instances, 61 at the lower bound.
  assert.equal(six.compute.apiInstancesAt60Percent, 86);
  assert.equal(six.compute.apiInstancesAt60PercentLowerBound, 61);
  // After A1 + C4-8 (c9's re-run, ≈5.5 ms per request): the workbook's own 59.
  assert.equal(six.compute.apiInstancesAfterA1, 59);
  // With c9's measured per-session CPU (0.77 → 0.56 ms, holds included), H2 cuts month-6 API instances from 59 to 46.
  assert.equal(six.compute.apiInstancesWithH2Measured, 46);
  // H2 halves the poll term: (6,383 − 1,825) req/s × 8 ms at 60%.
  assert.equal(six.compute.apiInstancesWithH2, Math.ceil((six.compute.apiRequestsPerSecond - 1825) * 0.008 / 0.6));
  assert.equal(six.compute.workbookApiInstances, 59);
});

test('per-process authorization reuse barely hits under random routing at launch-scale instance counts', () => {
  // The API carries the two 20 s polls (0.1 requests/s per agent) once holds move to the held-control service.
  const r = 0.1, months = evaluateForecast();
  const six = months[5].compute.apiInstancesAfterA1; // 59
  assert.ok(authReuseHitRate(r, 20, six) < 0.04);
  assert.ok(authReuseHitRate(r, 60, six) < 0.1);
  // One process (today's deployment) or affinity: most requests hit within 20 s.
  assert.ok(authReuseHitRate(r, 20, 1) > 0.85);
  assert.ok(Math.abs(authReuseHitRate(r, 20, 10) - (1 - Math.exp(-0.2))) < 1e-12);
  assert.throws(() => authReuseHitRate(r, 20, 0));
});

test('idle runner writes match the workbook with a shared contact throttle, and run high without it at scale', () => {
  const months = evaluateForecast();
  for (const m of months) {
    // 2 session writes per 20 s plus one contact per 60 s, on both sides, once C4-1 and C4-10 are in.
    assert.ok(Math.abs(m.writes.sharedThrottlePerSecond - m.writes.workbookIdlePerSecond) < 1e-9);
    assert.ok(m.writes.perProcessThrottlePerSecond >= m.writes.sharedThrottlePerSecond * (m.writes.instances > 1 ? 1 : 0.9));
  }
  const six = months[5];
  assert.equal(six.writes.instances, 59);
  assert.equal(Math.round(six.writes.workbookIdlePerSecond), 4258);
  // Per-process throttle at 59 API instances: (2 + 59/62) / 20 per session, ≈1.27× the workbook, ≈$750/month more.
  assert.equal(Math.round(six.writes.perProcessThrottlePerSecond), 5387);
  assert.equal(Math.round(six.writes.perProcessThrottleUsdPerMonth - six.writes.sharedThrottleUsdPerMonth), 746);
  // Month 1 runs on one instance, where the per-process throttle already writes below once a minute (1/4 per poll).
  assert.equal(months[0].writes.instances, 1);
  assert.ok(months[0].writes.perProcessThrottlePerSecond < months[0].writes.sharedThrottlePerSecond);
});
