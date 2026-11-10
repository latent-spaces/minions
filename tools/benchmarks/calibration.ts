import { pathToFileURL } from 'node:url';
// Observational calibration (owner steer, 26 October): the coordinator's billing aggregate for the karma42-launch project
// against the counted unit work of the deployed runner protocol. Model-free and read-only: it takes aggregates as
// inputs and derives ratios. The billing window is mixed history (every project, every user, Oct 1-26), so it is a
// sanity bound on per-request ratios, never a measurement of this lab or of any integrated slice.

// Coordinator observation, karma42-launch usage Oct 1-26 2026 (billing export; delayed and incomplete for recent days).
export const BILLING_OCT_1_26 = {
  days: 26, firestoreReads: 41_599_299, firestoreWrites: 1_323_724, cloudRunRequests: 1_532_671,
  grossIls: 75.98, netIls: 0,
} as const;

// Deployed runner protocol (main 0c86ba90; no C4-1, C4-7, C4-8 or A1): per connected idle session every 20 s a /wait and
// a /worker-session, every 25 s a held renewal followed by a /worker-session sync. Reads and writes per request are the
// counts of apps/server/test/steady-state-unit-work.test.ts at 319c5e67 (emulator SDK operations mapped to billing
// rules, so listeners, index entries and retries are not included).
export const DEPLOYED_RUNNER = {
  requests: [
    // The connector's tick posts {run_id} with no report: counted on the deployed source 0c86ba90 at 19 warm reads (22 cold) and
    // ≈1/3 write per poll (contact written once per 60 s per process; c5's wait-contact-unit-work.test.ts, 379865bf).
    { route: '/wait', perSecond: 1 / 20, reads: 19, writes: 1 / 3 },
    { route: '/worker-session (tick)', perSecond: 1 / 20, reads: 25, writes: 2 },
    { route: '/project-control', perSecond: 1 / 25, reads: 26, writes: 0 },
    { route: '/worker-session (after each control return)', perSecond: 1 / 25, reads: 25, writes: 2 },
  ],
} as const;

// Firestore free tier per day (documented quotas; the Tel Aviv price is the workbook's Drivers row 86-87).
export const FREE_TIER_PER_DAY = { reads: 50_000, writes: 20_000 } as const;
export const USD_PER_100K = { reads: 0.034, writes: 0.102 } as const;

export function calibrate(billing = BILLING_OCT_1_26, runner = DEPLOYED_RUNNER) {
  const seconds = billing.days * 86_400;
  const perSession = runner.requests.reduce((acc, r) => ({ requests: acc.requests + r.perSecond,
    reads: acc.reads + r.perSecond * r.reads, writes: acc.writes + r.perSecond * r.writes }), { requests: 0, reads: 0, writes: 0 });
  const runnerReadsPerRequest = perSession.reads / perSession.requests;
  const runnerWritesPerRequest = perSession.writes / perSession.requests;
  const billedReadsPerRequest = billing.firestoreReads / billing.cloudRunRequests;
  const billedWritesPerRequest = billing.firestoreWrites / billing.cloudRunRequests;
  const billableReads = Math.max(0, billing.firestoreReads - FREE_TIER_PER_DAY.reads * billing.days);
  const billableWrites = Math.max(0, billing.firestoreWrites - FREE_TIER_PER_DAY.writes * billing.days);
  return {
    perSession,
    runnerReadsPerRequest, runnerWritesPerRequest,
    billedReadsPerRequest, billedWritesPerRequest,
    // How far billed work per HTTP request sits from the counted runner mix. This holds only if most requests are runner
    // traffic; viewer polls (3-9 reads), directory pages (≈135) and owner polls (2-3) pull it in either direction.
    readRatio: billedReadsPerRequest / runnerReadsPerRequest, writeRatio: billedWritesPerRequest / runnerWritesPerRequest,
    // Mean connected idle sessions the aggregate would imply if every request were runner traffic. From reads ÷ from
    // requests equals readRatio exactly, so these are one check, not two (c5).
    impliedSessionsFromRequests: billing.cloudRunRequests / seconds / perSession.requests,
    impliedSessionsFromReads: billing.firestoreReads / seconds / perSession.reads,
    meanReadsPerSecond: billing.firestoreReads / seconds, meanRequestsPerSecond: billing.cloudRunRequests / seconds,
    billableReads, billableWrites,
    firestoreUsdAtWorkbookPrices: billableReads * USD_PER_100K.reads / 100_000 + billableWrites * USD_PER_100K.writes / 100_000,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = calibrate();
  console.info(JSON.stringify(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'number' ? +v.toFixed(3) : v])), null, 1));
}
