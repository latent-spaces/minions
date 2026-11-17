import { pathToFileURL } from 'node:url';
// Model-free capacity comparison of equal-session project shapes. It reads no data and measures
// nothing: coefficients are editable assumptions, and each source-derived bound names its file.
// Use it to find which bounds a shape crosses before choosing a (separately approved) measurement.
export type Shape = { projects: number; sessionsPerProject: number };
export type Assumptions = {
  busyFraction: number;            // model-busy share of connected sessions
  registeredPerConnected: number;  // retained bindings per connected session
  sessionsPerBinding: number;      // connected sessions sharing one local-service/project binding
  ownersPerProject: number;        // distinct people running computers for one project
  computersPerOwner: number;       // installed services one person runs (all projects)
  participationsPerComputer: number; backgroundsPerComputer: number;
  viewersPerProject: number;       // open browser viewers per active project
  membersPerProject: number;       // people listed by the members directory
  revokedPerProject: number;       // retained revoked agent records per project
};
// Source bounds at baseline ffb48180; update with the source when a slice changes them.
export const SOURCE_BOUNDS = {
  limiterKeysPerProcess: 20_000,            // apps/server/src/request-state.ts WindowLimitStore maxKeys
  limiterNamespaceShare: 0.25,              // same constructor: one namespace may hold 5,000 keys
  // apps/server/src/v2/routes.ts:64-67,171-172: v2-wait (/wait), v2-control (/project-control) and v2-tools per connected
  // agent: /worker-session is charged to the tool window and every connected session syncs it every 20 s, idle or busy (c8,
  // counted in apps/server/test/steady-state-unit-work.test.ts). Keys stay 60 s after their last touch (MAX_WINDOW_MS).
  routerCacheProjects: 100,                 // apps/server/src/projects/routes.ts FIFO scoped routers
  viewerRequestsPerMinute: 60,              // apps/server/src/view/routes.ts REQUESTS_PER_MINUTE per project namespace
  mapStatusBatch: 60, mapStatusPacingS: 3,  // apps/web/src/ui/communication-map/read-roster.ts:22-28 (c2)
  rosterRefreshS: 60,                       // apps/web/src/ui/ProjectCommunication.tsx:73 (c2)
  directoryPage: 20, directoryMaxPages: 25, // apps/web all-pages.ts:1; tasks walk /agents and /members each 30 s (c2)
  fanoutPage: 100, fanoutPagesPerInvocation: 4, // apps/server/src/v2/fanout.ts:16,70 (c3)
  ownerPersonPerMinute: 60,                 // apps/server/src/owner/routes.ts:139 owner-person, shared with human actions
  heldControlTimeoutS: 25,                  // apps/server/src/projects/project-control.ts timeoutMs
} as const;
export const DEFAULT_ASSUMPTIONS: Assumptions = {
  busyFraction: 0.3, registeredPerConnected: 1, sessionsPerBinding: 1, ownersPerProject: 1,
  viewersPerProject: 1, membersPerProject: 10, revokedPerProject: 0,
  computersPerOwner: 1, participationsPerComputer: 1, backgroundsPerComputer: 1,
};
export const EQUAL_5000_SHAPES: readonly Shape[] = [
  { projects: 1, sessionsPerProject: 5000 }, { projects: 10, sessionsPerProject: 500 },
  { projects: 100, sessionsPerProject: 50 }, { projects: 1000, sessionsPerProject: 5 },
];

// U1 with c5's probe (view/project-usage.ts): a 65-record first page; at or below 64 records the scan finishes from it
// plus the agent count (1 read per 1,000 entries). Above 64, a complete aggregate costs the probe, three counts, at most
// 64 shards and the latest record.
// Process-local limiter keys one connected session holds on a process that sees it (wait, control, tools).
export const KEYS_PER_SESSION = 3;

export const usageReadsPerRefresh = (records: number, agents: number) => records > 64 ? 65 + 3 * Math.ceil(records / 1000) + 64 + 1 : records + Math.ceil(agents / 1000);

/** HISTORICAL cost model: the status feed (c2 S3) and its S3c stride flag were deleted at card 19 (c3 S5); the map now
 * reads /communication/agents/current. Kept only to reproduce the earlier forecasts.
 * Status feed polls a minute for one visible map: S = power of two ≥ ⌈agents/120⌉ blocks, one
 * per 3 s slot of a max(5, S)-slot pass; by default a map polls at every active slot (20/min from S = 5). With the S3c
 * stride (a deleted owner opt-in) it polls two slots on when both read a block and the
 * catch-up returns the skipped one: half the blocks arrive 3 s later, and polls fall to 1 a pass for S = 1, 2 for S = 2,
 * 3 for S = 4 and S/2 above. */
export function statusFeedPollsPerMinute(agents: number, stride = false) {
  const S = 2 ** Math.ceil(Math.log2(Math.max(1, Math.ceil(agents / 120)))), slots = Math.max(5, S), active = (s: number) => s % slots < S;
  let polls = 0;
  for (let slot = 0; slot < slots; polls++) {
    let next = slot + 1;
    while (!active(next)) next++;
    if (stride && next === slot + 1 && active(slot + 2)) next = slot + 2;
    slot = next;
  }
  return polls * 60 / (slots * 3);
}

export function evaluateShape(shape: Shape, a: Assumptions = DEFAULT_ASSUMPTIONS) {
  const { projects: P, sessionsPerProject: S } = shape;
  if (!Number.isInteger(P) || P < 1 || !Number.isInteger(S) || S < 1) throw new Error('Invalid shape.');
  if (!(a.sessionsPerBinding >= 1)) throw new Error('Invalid assumptions.');
  const b = SOURCE_BOUNDS;
  const C = P * S;
  const busy = Math.round(C * a.busyFraction);
  const registered = Math.round(C * a.registeredPerConnected);
  // A binding never spans projects, so each project needs at least one.
  const K = P * Math.max(1, Math.ceil(S / a.sessionsPerBinding));
  const viewers = P * a.viewersPerProject;
  // Control demand (c4, controllers.mjs:96,117,128 at ffb48180): wait + session every 20 s, a held
  // project-control renewal every 25 s and a session sync after each return = 0.18·C. C4-1 skips the
  // sync on unchanged returns (0.14·C). C4-2 shares one project listener per process (C -> P targets).
  // The merged heartbeat C/20 + K/25 is a later wire change.
  const T = b.heldControlTimeoutS;
  const control = { currentPerSecond: 2 * C / 20 + 2 * C / T, unchangedSyncSkippedPerSecond: 2 * C / 20 + C / T,
    mergedHeartbeatPerSecond: C / 20 + K / T,
    currentHeld: C, mergedHeartbeatHeld: K, listenTargetsNow: C, listenTargetsShared: P,
    largestProjectListeners: S };
  // Worst case without affinity: every process eventually holds every active identity's windows.
  const namespaceCap = Math.floor(b.limiterKeysPerProcess * b.limiterNamespaceShare);
  const sessionKeysPerProcess = KEYS_PER_SESSION * C;
  const limiter = {
    namespaceCap,
    largestProjectNamespaceKeys: S,
    // At the cap a project has no room for one more agent, takeover or replacement identity.
    namespaceFull: S >= namespaceCap,
    sessionKeysPerProcess,
    storeOverflow: sessionKeysPerProcess + viewers > b.limiterKeysPerProcess,
  };
  const routerCache = { activeProjectsPerProcess: P, churn: P > b.routerCacheProjects };
  const sweepS = (Math.ceil(S / b.mapStatusBatch) - 1) * b.mapStatusPacingS;
  // One visible viewer, before navigation (c2, verified at ffb48180). The status sweep effect runs every
  // 15 s with a busy guard: min(20, 4·⌈S/60⌉) reads/min. Baseline walks are unpaced; after B1 (c2) the
  // roster and member walks average ≤10 req/min each and the sweep resumes instead of restarting.
  const A = Math.round(S * a.registeredPerConnected), M = a.membersPerProject;
  const walk = (n: number) => Math.min(Math.ceil(n / b.directoryPage), b.directoryMaxPages);
  const sweepPerMinute = Math.min(20, 4 * Math.ceil(S / b.mapStatusBatch));
  const mapPerMinute = 12 + sweepPerMinute + Math.ceil(A / 200) + Math.ceil(M / 20);
  const mapPerMinutePaced = 12 + sweepPerMinute + Math.min(Math.ceil(A / 200), 10) + Math.min(Math.ceil(M / 20), 10);
  // With the shared status feed (S3) the map polls the feed instead of sweeping 60 ids per request: by default once per
  // active slot (the same 20/min as the sweep), or with the S3c stride (owner opt-in, 3 s later for half the blocks) fewer.
  const feedPollsPerMinute = statusFeedPollsPerMinute(S), feedPollsPerMinuteStride = statusFeedPollsPerMinute(S, true);
  const walks = Math.min(Math.ceil(A / 200), 10) + Math.min(Math.ceil(M / 20), 10);
  const mapPerMinuteFeed = 12 + feedPollsPerMinute + walks, mapPerMinuteFeedStride = 12 + feedPollsPerMinuteStride + walks;
  const tasksPerMinute = 7 + 2 * (walk(A) + walk(M));
  const tasksPerMinutePaced = 7 + Math.min(2 * walk(A), 10) + Math.min(2 * walk(M), 10);
  const worst = Math.max(mapPerMinute, tasksPerMinute);
  const viewer = { mapPerMinute, mapPerMinutePaced, feedPollsPerMinute, mapPerMinuteFeed, feedPollsPerMinuteStride, mapPerMinuteFeedStride, tasksPerMinute, tasksPerMinutePaced, budgetPerMinute: b.viewerRequestsPerMinute,
    overBudget: worst > b.viewerRequestsPerMinute,
    // The README incident was refused after exactly 60 successful reads: above 80% leaves no room to navigate.
    noNavigationHeadroom: worst > 0.8 * b.viewerRequestsPerMinute,
    directoryTruncated: Math.max(A, M) > b.directoryPage * b.directoryMaxPages,
    mapSweepS: sweepS, mapSweepCancelledByRosterBaseline: sweepS >= b.rosterRefreshS,
    mapSweepRestartsToCoverAfterB1: Math.ceil(Math.ceil(A / b.mapStatusBatch) / 19) };
  // Usage panel (c5, view/routes.ts:87, project-usage.ts:7-28): every viewer poll (30 s) reads every
  // retained usage record; after S1(b) one coalesced read per project router per 10 s.
  const usage = { docReadsPerSecondNow: P * a.viewersPerProject * (A + a.revokedPerProject) / 30,
    docReadsPerSecondCoalesced: (a.viewersPerProject > 0 ? P : 0) * (A + a.revokedPerProject) / 10,
    // After U1 (usageReadsPerRefresh). Assumes every record of a large project is aggregated.
    docReadsPerSecondAggregated: (a.viewersPerProject > 0 ? P : 0) * usageReadsPerRefresh(A + a.revokedPerProject, A + a.revokedPerProject) / 10 };
  // Discovery pages every retained record today; c3's R1 pages only live records.
  const invocations = (records: number) => Math.ceil(Math.ceil(records / b.fanoutPage) / b.fanoutPagesPerInvocation);
  // Owner transport (c4, owner-participation-controls.mjs:148, owner-background-controls.mjs:94-97): every
  // computer syncs every 15 s, ⌈n/32⌉ batches each, charged to its person's 60/min budget before any click.
  const perComputer = 4 * (2 + Math.ceil(a.participationsPerComputer / 32) + Math.ceil(a.backgroundsPerComputer / 32));
  const owner = { personPerMinute: a.computersPerOwner * perComputer, budgetPerMinute: b.ownerPersonPerMinute,
    overBudget: a.computersPerOwner * perComputer > b.ownerPersonPerMinute };
  const broadcast = { invocationsNow: invocations(A + a.revokedPerProject), invocationsLiveOnly: invocations(A) };
  const crossed = [
    limiter.namespaceFull && 'limiter_namespace_full', limiter.storeOverflow && 'limiter_store',
    routerCache.churn && 'router_cache_churn', owner.overBudget && 'owner_budget', viewer.overBudget && 'viewer_budget', !viewer.overBudget && viewer.noNavigationHeadroom && 'viewer_no_headroom',
    viewer.directoryTruncated && 'directory_truncated', viewer.mapSweepCancelledByRosterBaseline && 'map_sweep_cancelled',
  ].filter((x): x is string => typeof x === 'string');
  return { shape, connected: C, busy, registered, bindings: K, viewers, control, limiter, routerCache, viewer, usage, owner, broadcast, crossed };
}

export function compareShapes(shapes: readonly Shape[] = EQUAL_5000_SHAPES, a: Assumptions = DEFAULT_ASSUMPTIONS) {
  return shapes.map(shape => evaluateShape(shape, a));
}

// Forecast months (FM1). Inputs copy the workbook's editable hypotheses (research/platform-scale/forecast.xlsx, Drivers
// rows 6-9, 11, 18-21, 23-36, 40-42); they are not observed adoption. Each month is the workbook's normal peak (every
// segment at ROUNDUP(20% of its monthly projects)), its all-flagship event, and its capacity target (the higher of 2× the
// normal peak and the event, Forecast row 38). Source-derived terms sit next to the workbook row they replace.
export const SEGMENTS = ['small', 'team', 'large', 'flagship'] as const;
type Segment = typeof SEGMENTS[number];
const perSegment = <T>(small: T, team: T, large: T, flagship: T): Record<Segment, T> => ({ small, team, large, flagship });
export const WORKBOOK = {
  months: ['2026-11', '2026-12', '2027-01', '2027-02', '2027-03', '2027-04'],
  monthlyProjects: [perSegment(90, 10, 0, 0), perSegment(350, 40, 8, 2), perSegment(850, 125, 20, 5),
    perSegment(1650, 290, 54, 6), perSegment(2450, 465, 78, 7), perSegment(4000, 850, 140, 10)],
  peakFraction: 0.2,
  sessionsPerProject: perSegment(5, 50, 500, 5000),
  sessionsPerBinding: perSegment(1, 2, 5, 10),
  viewersPerProject: perSegment(0.5, 3, 15, 100),
  membersPerProject: perSegment(2, 20, 200, 1000),
  // Drivers rows 13-16, 46, 89: registered bindings per project (broadcast audience), one broadcast per active project
  // per 600 s, at most 400 recipients per task slice. The 5× message burst is the README's.
  registeredPerProject: perSegment(10, 100, 1000, 5000), broadcastS: 600, recipientsPerSlice: 400, messageBurst: 5,
  averagePeakRatio: 0.25, secondsPerMonth: 2_592_000, capacityMultiplier: 2,
  // Drivers rows 50-53, 55-56, 60: the proposed combined heartbeat and per-binding renewal, with assumed unit reads.
  heartbeatS: 20, renewalS: 25, ownerSyncS: 15, viewerReadS: 10, readsPerHeartbeat: 8, readsPerRenewal: 12, readsPerViewerRead: 20,
  usdPer100kReads: 0.034,
  // Drivers rows 125, 62 and 87: worker-session writes per heartbeat, the contact-write interval and the write price
  // (Infrastructure row 24 also adds owner snapshots, usage, delivery and tool writes, which are not compared here).
  workerSessionWritesPerHeartbeat: 2, contactWriteS: 60, usdPer100kWrites: 0.102,
} as const;
// Idle runner writes, counted: /worker-session writes 2 per call (steady-state-unit-work at integration f3ff2acc), and a
// no-report /wait writes the contact on ≈1/3 of 20 s polls at one instance (c5 wait-contact-unit-work, 379865bf). Since
// C4-1 the connector re-syncs its session after a held control reply only when the revision changed
// (packages/agent-cli/src/service/controllers.mjs holdProject), so a quiet renewal writes nothing.
export const COUNTED_IDLE_WRITES = { workerSession: 2 } as const;
// Contact writes per 20 s poll: a per-process throttle under random routing over I instances writes ≈I/(I+3) (c4); C4-10
// (bd2ed29a, approved, not yet integrated) keeps the stored contact as the shared state, ≈1/3 at any I.
export const contactWritesPerPoll = (instances: number, sharedThrottle: boolean) => {
  if (!(Number.isInteger(instances) && instances >= 1)) throw new Error('Invalid instances.');
  return sharedThrottle ? 1 / 3 : instances / (instances + 3);
};
// Counted on the emulator at integration 319c5e67 (apps/server/test/steady-state-unit-work.test.ts), shared project
// caches warm: Firestore document reads per runner request. Counts, not billing: listener snapshots are not seen.
export const COUNTED_READS = { wait: 24, workerSession: 25, projectControl: 26 } as const;
// Same test: authentication 6 and one run check 10 per request; a first project-control reply on cold caches 27; an
// unchanged held renewal 16 after C4-8 (b3b24dd2, counted on a simulated integration).
// Busy-session work, same test: a tool call (empty read_agent_inbox) 27 reads; each delivered recipient of a direct send
// 3.5 reads and 3 writes; a usage report on /wait +7 reads and +3 writes over a plain wait.
export const COUNTED_BUSY = { toolCall: 27, perRecipient: 3.5, usageReportExtra: 7 } as const;
// c4's flag-off H2 prototype (5a9edfee): one observe+session beat reads 41 against the pair's 49 (one authentication saved;
// the two run fences still run separately until a merged fence lands).
// After A1 (c5; cd159b78 with C4-8, counted on a simulated integration with S2 in): warm /wait 22, /worker-session 24, a
// quiet held renewal 11; a tool call 21, each extra recipient (35 − 29)/2 = 3 reads, a usage report +7 over a wait.
// c4's merged-fence heartbeat (b91e5f0a, flag off) saves 10 reads per beat against the pair in the same probe, so ≈36 per
// beat in steady state after A1.
export const COUNTED_AFTER_A1 = { wait: 22, workerSession: 24, quietRenewal: 11, toolCall: 21, perRecipient: 3, usageReportExtra: 7,
  mergedFenceBeat: 36 } as const;
export const COUNTED_PARTS = { auth: 6, runCheck: 10, firstControlReply: 27, unchangedRenewal: 16, heartbeatPrototype: 41 } as const;
// Viewer routes, all view caches cold (same test), over connected agents with a run and a synced worker session: the map
// status sweep /communication/agents?ids= reads ≈ 9 + 5.2 per id (presence, run, session pointer, session and chunked
// queries), and the directory /agents ≈ 10 + 7.2 per row. Fixed polls are small (overview 9, usage 5, frame 5, traffic 4).
// c5's S2 (62a51afc, in review) reads the session's summary from the pointer: one read fewer per connected agent.
export const COUNTED_VIEWER_READS = { statusBase: 9, statusPerId: 5.2, directoryBase: 10, directoryPerRow: 7.2 } as const;
// The shared status feed (c2 S3, S3b; status-feed-unit-work): each poll pays authentication and Needs you (≈4 counted,
// 4-6 with the minute's count()), and a block reused from the shared document costs one read. A computed block keeps the
// sweep's per-agent cost (statusBase + S2's statusPerId − 1 per agent; 321-435 counted for 65-85 synthetic agents
// without sessions over three runs, ≈4-5 each with the agent read). S3b is off unless the owner enables it.
// The Tasks tab's label walk with `/agents?view=labels` (c2, agent-labels-unit-work): 26-27 reads for a 20-row page of
// synthetic agents without sessions against 138-139 for full rows; label rows read the agent and its owners only.
// Counted with 2 owners per page: each further distinct owner adds a profile read (c8), so a page whose 20 agents all
// have different owners costs ≈45-47, perRow 2 as an upper bound (month 6 ≈8k reads/s instead of 4.3k).
export const COUNTED_LABEL_PAGE = { base: 7, perRow: 1 } as const;
export const COUNTED_STATUS_FEED = { perPoll: 4, sharedBlock: 1, blockAgents: 120, slotS: 3, minSlots: 5 } as const;
// Requests per connected session per minute that touch each limiter key today (after C4-1): /wait and /worker-session
// every 20 s, a project-control renewal every 25 s.
export const KEY_TOUCHES_PER_MINUTE = { wait: 3, tools: 3, control: 60 / 25 } as const;
// Expected keys one process holds when N processes share traffic at random: a key stays 60 s after its last touch, so
// a process holds a session's key if any of that minute's r touches reached it, 1 − (1 − 1/N)^r. Load-based routing
// and affinity are not random; affinity concentrates one project's keys on one process again.
export const keysPerProcess = (sessions: number, instances: number) => {
  if (!(Number.isInteger(instances) && instances >= 1)) throw new Error('Invalid instances.');
  return sessions * Object.values(KEY_TOUCHES_PER_MINUTE).reduce((sum, r) => sum + 1 - (1 - 1 / instances) ** r, 0);
};
// Smallest instance count at which one process's expected keys fit under a bound (null if none up to 10,000).
const instancesToFit = (sessions: number, bound: number) => {
  for (let n = 1; n <= 10_000; n++) if (keysPerProcess(sessions, n) <= bound) return n;
  return null;
};

export function evaluateForecastMonth(index: number) {
  const w = WORKBOOK, b = SOURCE_BOUNDS, monthly = w.monthlyProjects[index];
  if (!monthly) throw new Error('Invalid forecast month.');
  const peak = Object.fromEntries(SEGMENTS.map(s => [s, Math.ceil(monthly[s] * w.peakFraction)])) as Record<Segment, number>;
  const sum = (f: (s: Segment) => number) => SEGMENTS.reduce((total, s) => total + f(s), 0);
  const C = sum(s => peak[s] * w.sessionsPerProject[s]);
  const K = sum(s => peak[s] * w.sessionsPerProject[s] / w.sessionsPerBinding[s]);
  const viewers = sum(s => peak[s] * w.viewersPerProject[s]);
  const extraFlagships = monthly.flagship - peak.flagship;
  const eventSessions = C + extraFlagships * w.sessionsPerProject.flagship;
  const capacityTarget = Math.max(C * w.capacityMultiplier, eventSessions);
  const registered = sum(s => peak[s] * w.registeredPerProject[s]);
  // Workbook rows (Infrastructure 6-8, 11, and the control/heartbeat part of row 23).
  const workbook = { heartbeatPerSecond: C / w.heartbeatS, renewalsPerSecond: K / w.renewalS, ownerPerSecond: K / w.ownerSyncS,
    viewerPerSecond: viewers / w.viewerReadS, controlReadsPerSecond: C / w.heartbeatS * w.readsPerHeartbeat + K / w.renewalS * w.readsPerRenewal };
  // Today's source (c4, after C4-1): 0.14·C req/s and C held requests, idle included.
  const r = COUNTED_READS;
  const countedReadsPerSession = r.wait / 20 + r.workerSession / 20 + r.projectControl / w.renewalS;
  const controlReadsPerSecond = C * countedReadsPerSession;
  const monthlyUsd = (readsPerSecond: number) => readsPerSecond * w.averagePeakRatio * w.secondsPerMonth * w.usdPer100kReads / 100_000;
  // Viewer polling per visible tab after B1/V1 (evaluateShape, paced figures), weighted by the workbook's viewers.
  const tab = (s: Segment) => evaluateShape({ projects: 1, sessionsPerProject: w.sessionsPerProject[s] },
    { ...DEFAULT_ASSUMPTIONS, membersPerProject: w.membersPerProject[s] }).viewer;
  // One visible map tab's status sweep: min(20, 4·⌈S/60⌉) batches/min of min(60, S) ids (read-roster.ts, c2).
  const v = COUNTED_VIEWER_READS;
  const sweepReadsPerSecond = (S: number) => Math.min(20, 4 * Math.ceil(S / b.mapStatusBatch)) / 60 * (v.statusBase + v.statusPerId * Math.min(b.mapStatusBatch, S));
  const mapSweepReadsPerSecond = sum(s => peak[s] * w.viewersPerProject[s] * sweepReadsPerSecond(w.sessionsPerProject[s]));
  const workbookViewerReadsPerSecond = viewers / w.viewerReadS * w.readsPerViewerRead;
  const viewerPerSecond = { map: sum(s => peak[s] * w.viewersPerProject[s] * tab(s).mapPerMinutePaced / 60),
    tasks: sum(s => peak[s] * w.viewersPerProject[s] * tab(s).tasksPerMinutePaced / 60) };
  // Owner transport after C4-3 (c4): 8 + 4/3·(⌈Pc/32⌉ + ⌈Bc/32⌉) req/min per active computer. The workbook proxies one
  // computer per binding; with one participation and one background per computer that is 32/3 req/min, not 4.
  const ownerPerComputerPerMinute = 8 + 4 / 3 * 2;
  const heldInstances = Math.ceil(C / 60);   // c4: API at concurrency 80, 75% held
  // Control transport options (c4 CT1, c4-runtime-control.md; reads from the counted parts). K is the workbook's
  // (computer, project) bindings: s = 1/2/5/10 sessions per binding by segment. Holds per binding come from C4-7;
  // C4-8 makes an unchanged renewal 16 reads. (a) moves the K holds to a held-control service at concurrency 1,000
  // (≤750 each); keeping them on the API at 80 needs ⌈K/60⌉. (c) is the merged 20 s heartbeat (a wire change), one
  // authentication and one run check per session per 20 s instead of two. Recovery (c4): when servers fail, groups keep
  // their revision, so each re-hold costs an unchanged renewal (K × 16), over ~3 s with c6's drain or 20-30 s after a
  // crash (C4-9); a mass connector restart loses group revisions, so each first reply is cold (K × 27).
  const p = COUNTED_PARTS, polls = r.wait + r.workerSession;
  // Bindings at the capacity target: the all-flagship event adds flagships at their own s (Forecast row 34); 2× peak doubles K.
  const eventBindings = K + extraFlagships * w.sessionsPerProject.flagship / w.sessionsPerBinding.flagship;
  const targetBindings = eventSessions >= C * w.capacityMultiplier ? eventBindings : K * w.capacityMultiplier;
  const transport = {
    beforeSharedHold: { held: C, requestsPerSecond: 0.14 * C, readsPerSecond: controlReadsPerSecond },
    sharedHold: { held: K, requestsPerSecond: C / 10 + K / w.renewalS, readsPerSecond: C * polls / 20 + K * p.unchangedRenewal / w.renewalS },
    heldServiceInstances: Math.ceil(K / 750), apiOnlyHeldInstances: Math.ceil(K / 60),
    capacityTarget: { bindings: targetBindings, heldServiceInstances: Math.ceil(targetBindings / 750), apiOnlyHeldInstances: Math.ceil(targetBindings / 60) },
    heartbeatPrototype: { held: K, requestsPerSecond: C / w.heartbeatS + K / w.renewalS,
      readsPerSecond: C * p.heartbeatPrototype / w.heartbeatS + K * p.unchangedRenewal / w.renewalS },
    // Counted path: A1 and C4-8 (integrated, active) plus c4's merged fence (b91e5f0a). Only /v2/heartbeat itself waits
    // for the owner's H2 sign-off. The K term uses a quiet renewal (11); a renewal that answers a changed revision
    // still costs about 17, so with frequent wakes this is a lower bound.
    mergedFenceAfterA1: { held: K, requestsPerSecond: C / w.heartbeatS + K / w.renewalS,
      readsPerSecond: C * COUNTED_AFTER_A1.mergedFenceBeat / w.heartbeatS + K * COUNTED_AFTER_A1.quietRenewal / w.renewalS },
    mergedHeartbeat: { held: K, requestsPerSecond: C / w.heartbeatS + K / w.renewalS,
      readsPerSecond: C * (polls - p.auth - p.runCheck) / w.heartbeatS + K * p.unchangedRenewal / w.renewalS },
    recoveryReads: { serverSide: K * p.unchangedRenewal, connectorRestart: K * p.firstControlReply },
  };
  // Delivery task slices (scale-codex-1's challenge, workbook Infrastructure row 20): a broadcast needs ⌈audience/400⌉
  // slices however small, one runFanout invocation each (v2/fanout.ts, 4 pages of 100). A project-wide message runs its
  // first slice inside the sending request (deliverProjectWide), so when that succeeds only the rest reach the queue
  // (README: 4 dispatches/s, 4 concurrent). If it fails, or for creators without a request slice (scheduled start), every
  // slice is queued. Direct sends do not use the queue. Retries, stale hints and empty final pages add to both.
  // Exact count (scale-codex-1): a slice ends the fanout only on a short page, so A live discovery rows need ⌊A/400⌋ + 1
  // invocations (an exact multiple of 400 adds an empty final one); the workbook's ⌈A/400⌉ matches for its audiences.
  const invocations = (A: number) => Math.floor(A / w.recipientsPerSlice) + 1;
  const slices = sum(s => peak[s] * invocations(w.registeredPerProject[s])) / w.broadcastS;
  const queuedAfterRequestSlice = sum(s => peak[s] * (invocations(w.registeredPerProject[s]) - 1)) / w.broadcastS;
  const QUEUE_DISPATCHES_PER_SECOND = 4;
  const delivery = { slicesPerSecond: slices, queuedAfterRequestSlicePerSecond: queuedAfterRequestSlice,
    requestSlicesPerSecond: slices - queuedAfterRequestSlice,
    burstQueueShareAfterRequestSlice: queuedAfterRequestSlice * w.messageBurst / QUEUE_DISPATCHES_PER_SECOND,
    burstQueueShareIfRequestSlicesFail: slices * w.messageBurst / QUEUE_DISPATCHES_PER_SECOND };
  const namespaceCap = Math.floor(b.limiterKeysPerProcess * b.limiterNamespaceShare);
  const flagshipNamespaceKeys = (n: number) => w.sessionsPerProject.flagship * (1 - (1 - 1 / n) ** KEY_TOUCHES_PER_MINUTE.tools);
  // Counted Firestore reads/s against the workbook's whole read line (Infrastructure row 23). The workbook's busy terms use
  // Drivers 39, 44-48: 30% busy, 2 tool calls/min, 12 usage reports/h, one direct send per session per 600 s to 3
  // recipients, one broadcast per active project per 600 s to its registered bindings. Owner transport is in the
  // workbook (8 reads per sync) but was not counted here, so it is left out of both sides. The map sweep assumes every
  // viewer has the map tab visible (an upper case); fixed viewer polls (≈5-9 reads) are left out.
  function totalReads() {
    const busy = C * 0.3, tools = busy * 2 / 60, usage = busy * 12 / 3600, recipients = C / 600 * 3 + registered / w.broadcastS;
    const b0 = SOURCE_BOUNDS, b = COUNTED_BUSY;
    const work = tools * b.toolCall + usage * b.usageReportExtra + recipients * b.perRecipient;
    const workbookWithoutOwner = (C / w.heartbeatS * w.readsPerHeartbeat + K / w.renewalS * w.readsPerRenewal + tools * 12 + usage * 8
      + viewers / w.viewerReadS * w.readsPerViewerRead) * 1.1 + recipients * 6;
    const today = controlReadsPerSecond + work + mapSweepReadsPerSecond;
    const built = transport.sharedHold.readsPerSecond + work + mapSweepReadsPerSecond;
    // With A1 and S2 as well (both integrated): one read fewer per swept connected agent. Quiet renewals (11) make the K
    // term a lower bound when project revisions change often (a changed answer costs about 17).
    const a = COUNTED_AFTER_A1;
    const sweepS2 = sum(s => peak[s] * w.viewersPerProject[s] * Math.min(20, 4 * Math.ceil(w.sessionsPerProject[s] / b0.mapStatusBatch)) / 60
      * (v.statusBase + (v.statusPerId - 1) * Math.min(b0.mapStatusBatch, w.sessionsPerProject[s])));
    const withA1 = C * (a.wait + a.workerSession) / w.heartbeatS + K * a.quietRenewal / w.renewalS
      + tools * a.toolCall + usage * a.usageReportExtra + recipients * a.perRecipient + sweepS2;
    return { busyWorkReadsPerSecond: work, todayReadsPerSecond: today, builtReadsPerSecond: built, withA1AndS2ReadsPerSecond: withA1,
      workbookReadsPerSecondWithoutOwner: workbookWithoutOwner,
      todayUsdPerMonth: monthlyUsd(today), builtUsdPerMonth: monthlyUsd(built), withA1AndS2UsdPerMonth: monthlyUsd(withA1),
      workbookUsdPerMonthWithoutOwner: monthlyUsd(workbookWithoutOwner) };
  }
  // API compute (c9, c9-held-control-memory.md, corrected in 254133fe: ≈8 ms of service CPU per runner request at the
  // protocol rate on one local core, 5.7 ms a lower bound; Cloud Run vCPUs are usually slower, unmeasured). Requests on the API once holds move to a held-control service:
  // the two 20 s polls (C/10), tool calls, visible viewer tabs (map, the busier tab) and idle owner mailboxes (8/min
  // per computer after C4-3; one computer per binding, the workbook's proxy). Instances at the workbook's 60% CPU
  // target and 1 vCPU each, against its illustrative API instances (Infrastructure row 31).
  // c9's re-run after A1 + C4-8 (b9c33b17): ≈5.5 ms per request (0.77 ms per session-second at 0.14 req/s).
  const LOCAL_CPU_MS_PER_REQUEST = 8, LOCAL_CPU_MS_LOWER_BOUND = 5.7, LOCAL_CPU_MS_AFTER_A1 = 5.5;
  const apiRequestsPerSecond = C / 10 + C * 0.3 * 2 / 60 + viewerPerSecond.map + K * 8 / 60;
  const apiCores = apiRequestsPerSecond * LOCAL_CPU_MS_PER_REQUEST / 1000;
  const compute = { apiRequestsPerSecond, apiCores, apiInstancesAt60Percent: Math.ceil(apiCores / 0.6),
    apiInstancesAt60PercentLowerBound: Math.ceil(apiRequestsPerSecond * LOCAL_CPU_MS_LOWER_BOUND / 1000 / 0.6),
    // With H2 (owner sign-off) the two polls become one beat per session per 20 s. The owner term uses one computer per
    // binding (an upper bound; real computers are at most the bindings).
    apiInstancesAfterA1: Math.ceil(apiRequestsPerSecond * LOCAL_CPU_MS_AFTER_A1 / 1000 / 0.6),
    apiInstancesWithH2: Math.ceil((apiRequestsPerSecond - C / 20) * LOCAL_CPU_MS_PER_REQUEST / 1000 / 0.6),
    // Measured per session-second (c9 c2371a55/6cbb0298, local, after A1, 500 sessions, single run): 0.77 ms with the two
    // polls and 0.56 ms with the beat, both including held renewals (0.04/s × 5.5 ms ≈ 0.22 ms; c4). So the polls cost
    // ≈0.55 ms per session-second and the beat ≈0.34 ms. Other API requests keep 5.5 ms each.
    apiInstancesWithH2Measured: Math.ceil(((apiRequestsPerSecond - C / 10) * LOCAL_CPU_MS_AFTER_A1 + C * (0.56 - 0.04 * LOCAL_CPU_MS_AFTER_A1)) / 1000 / 0.6),
    workbookApiInstances: Math.max(2, Math.ceil(workbookApiRequests() * 0.01 / 0.6)),
    heldControlCoresPer750: 750 / w.renewalS * LOCAL_CPU_MS_PER_REQUEST / 1000 };
  // Idle runner writes per second against the workbook's matching terms (heartbeat session writes and contact writes,
  // Infrastructure row 24). Random routing is taken over the API instances after A1.
  const writesUsd = (writesPerSecond: number) => writesPerSecond * w.averagePeakRatio * w.secondsPerMonth * w.usdPer100kWrites / 100_000;
  const idleWrites = (perPoll: number) => C * (COUNTED_IDLE_WRITES.workerSession + perPoll) / w.heartbeatS;
  const workbookIdleWrites = C * (w.workerSessionWritesPerHeartbeat / w.heartbeatS + 1 / w.contactWriteS);
  const writesInstances = Math.max(1, compute.apiInstancesAfterA1);
  const writes = { instances: writesInstances, workbookIdlePerSecond: workbookIdleWrites,
    perProcessThrottlePerSecond: idleWrites(contactWritesPerPoll(writesInstances, false)),
    sharedThrottlePerSecond: idleWrites(contactWritesPerPoll(writesInstances, true)),
    workbookIdleUsdPerMonth: writesUsd(workbookIdleWrites),
    perProcessThrottleUsdPerMonth: writesUsd(idleWrites(contactWritesPerPoll(writesInstances, false))),
    sharedThrottleUsdPerMonth: writesUsd(idleWrites(contactWritesPerPoll(writesInstances, true))) };
  // Map status reads per second, three designs, with the S2 per-agent cost (c2 S3/S3b). The old per-tab sweep reads every
  // agent for every visible map. S3 reads clock-aligned blocks (S = power of two ≥ ⌈A/120⌉, one per 3 s slot, a pass
  // max(15 s, 3S)) once per slot per process: under random routing over I instances a slot's polls by V viewers reach
  // E = I·(1 − (1 − 1/I)^V) processes. S3b shares each block through one document: one computed block per project and
  // slot, one cached read per other process reached, one write. V < 1 is the share of projects with one viewer.
  // Left out (c8): the computing process first reads the stale document too, S/passS more reads per watched project
  // (≈48 reads/s at month 6).
  function statusFeedReads() {
    const f = COUNTED_STATUS_FEED, perAgent = v.statusPerId - 1, I = writesInstances;
    let perTab = 0, s3 = 0, s3b = 0, blockWrites = 0, polls = 0;
    for (const s of SEGMENTS) {
      const A = w.sessionsPerProject[s], V = w.viewersPerProject[s], P = peak[s];
      const watched = V < 1 ? P * V : P, perProject = Math.max(1, V);
      perTab += P * V * Math.min(20, 4 * Math.ceil(A / b.mapStatusBatch)) / 60 * (v.statusBase + perAgent * Math.min(b.mapStatusBatch, A));
      const S = 2 ** Math.ceil(Math.log2(Math.max(1, Math.ceil(A / f.blockAgents)))), passS = Math.max(f.minSlots, S) * f.slotS;
      const readsPerPass = v.statusBase * S + perAgent * A, E = I * (1 - (1 - 1 / I) ** perProject);
      polls += watched * perProject * S / passS;  // one poll per active slot: an upper bound (large maps poll every other slot)
      s3 += watched * E * readsPerPass / passS;
      s3b += watched * (readsPerPass + (E - 1) * S * f.sharedBlock) / passS;
      blockWrites += watched * S / passS;
    }
    const s3Total = s3 + polls * f.perPoll, s3bTotal = s3b + polls * f.perPoll;
    return { instances: I, pollsPerSecond: polls, perTabReadsPerSecond: perTab, s3ReadsPerSecond: s3Total, s3bReadsPerSecond: s3bTotal,
      s3bWritesPerSecond: blockWrites, perTabUsdPerMonth: monthlyUsd(perTab), s3UsdPerMonth: monthlyUsd(s3Total),
      s3bUsdPerMonth: monthlyUsd(s3bTotal) + writesUsd(blockWrites) };
  }
  // Tasks-tab agent walk reads per second if every forecast viewer had that tab open (the map's upper case, other tab):
  // min(2·pages, 10) pages a minute after B1 (paced), full directory rows against the labels view.
  function tasksTabReads() {
    const pagesPerMinute = (A: number) => Math.min(2 * Math.min(Math.ceil(A / b.directoryPage), b.directoryMaxPages), 10);
    const rows = (A: number) => Math.min(b.directoryPage, A);
    const full = sum(s => peak[s] * w.viewersPerProject[s] * pagesPerMinute(w.sessionsPerProject[s]) / 60 * (v.directoryBase + v.directoryPerRow * rows(w.sessionsPerProject[s])));
    const labels = sum(s => peak[s] * w.viewersPerProject[s] * pagesPerMinute(w.sessionsPerProject[s]) / 60 * (COUNTED_LABEL_PAGE.base + COUNTED_LABEL_PAGE.perRow * rows(w.sessionsPerProject[s])));
    return { fullReadsPerSecond: full, labelsReadsPerSecond: labels, fullUsdPerMonth: monthlyUsd(full), labelsUsdPerMonth: monthlyUsd(labels) };
  }
  function workbookApiRequests() {
    const hb = C / w.heartbeatS, owner = K / w.ownerSyncS, tools = C * 0.3 * 2 / 60, usage = C * 0.3 * 12 / 3600, view = viewers / w.viewerReadS;
    return (hb + owner + tools + usage + view) * 1.1;
  }
  return {
    month: w.months[index], compute, writes, peakProjects: peak, connected: C, bindings: K, viewers, eventSessions, eventBindings, capacityTarget,
    workbook,
    control: { requestsPerSecond: 0.14 * C, held: C, heldApiInstances: heldInstances,
      countedReadsPerSession, readsPerSecond: controlReadsPerSecond, readsVsWorkbook: controlReadsPerSecond / workbook.controlReadsPerSecond,
      readsUsdPerMonth: monthlyUsd(controlReadsPerSecond), workbookReadsUsdPerMonth: monthlyUsd(workbook.controlReadsPerSecond) },
    delivery,
    totals: totalReads(),
    transport: { ...transport, readsUsdPerMonth: { beforeSharedHold: monthlyUsd(transport.beforeSharedHold.readsPerSecond),
      sharedHold: monthlyUsd(transport.sharedHold.readsPerSecond), mergedHeartbeat: monthlyUsd(transport.mergedHeartbeat.readsPerSecond) } },
    viewer: { ...viewerPerSecond, vsWorkbook: viewerPerSecond.map / workbook.viewerPerSecond,
      mapSweepReadsPerSecond, workbookReadsPerSecond: workbookViewerReadsPerSecond, sweepReadsVsWorkbook: mapSweepReadsPerSecond / workbookViewerReadsPerSecond,
      mapSweepReadsUsdPerMonth: monthlyUsd(mapSweepReadsPerSecond), statusFeed: statusFeedReads(), tasksTab: tasksTabReads() },
    owner: { perSecondIfOneComputerPerBinding: K * ownerPerComputerPerMinute / 60, vsWorkbook: ownerPerComputerPerMinute / 60 / (1 / w.ownerSyncS) },
    limiter: { keysOneProcess: keysPerProcess(C, 1), keysAtHeldInstances: keysPerProcess(C, heldInstances),
      instancesToFitStore: instancesToFit(C, b.limiterKeysPerProcess),
      // Tightest flagship namespace (tools or wait, three touches a minute) under random routing at the held instance count.
      flagshipNamespaceFull: peak.flagship > 0 && flagshipNamespaceKeys(heldInstances) >= namespaceCap,
      capacityTargetKeysOneProcess: keysPerProcess(capacityTarget, 1) },
  };
}
export const evaluateForecast = () => WORKBOOK.months.map((_, i) => evaluateForecastMonth(i));

// Authorization reuse (an owner choice: it sets a revocation latency T). A per-process cache keyed by credential hits only
// when the same agent's previous request reached the same process within T. With requests at r per second per agent
// spread at random over I processes, a process sees that agent at r/I, so the hit rate is 1 − exp(−r·T/I). With project
// or agent affinity (I = 1 for that agent) it is 1 − exp(−r·T). Derived; no cache exists in the code.
export function authReuseHitRate(requestsPerSecond: number, ttlS: number, instances: number) {
  if (!(requestsPerSecond >= 0 && ttlS >= 0 && Number.isInteger(instances) && instances >= 1)) throw new Error('Invalid reuse inputs.');
  return 1 - Math.exp(-requestsPerSecond * ttlS / instances);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const r of compareShapes()) console.info(JSON.stringify({ shape: `${r.shape.projects}x${r.shape.sessionsPerProject}`,
    controlNow: r.control.currentPerSecond, controlSkipSync: r.control.unchangedSyncSkippedPerSecond, controlMerged: r.control.mergedHeartbeatPerSecond, listenTargets: `${r.control.listenTargetsNow}->${r.control.listenTargetsShared}`, held: r.control.currentHeld, crossed: r.crossed }));
  for (const m of evaluateForecast()) console.info(JSON.stringify({ month: m.month, connected: m.connected, capacityTarget: m.capacityTarget,
    controlReadsPerSecond: Math.round(m.control.readsPerSecond), workbookControlReads: Math.round(m.workbook.controlReadsPerSecond),
    controlReadsUsd: Math.round(m.control.readsUsdPerMonth), heldApiInstances: m.control.heldApiInstances,
    keysOneProcess: Math.round(m.limiter.keysOneProcess), keysAtHeldInstances: Math.round(m.limiter.keysAtHeldInstances), instancesToFitStore: m.limiter.instancesToFitStore,
    flagshipNamespaceFull: m.limiter.flagshipNamespaceFull, mapSweepReadsPerSecond: Math.round(m.viewer.mapSweepReadsPerSecond),
    statusFeedReads: { perTab: Math.round(m.viewer.statusFeed.perTabReadsPerSecond), s3: Math.round(m.viewer.statusFeed.s3ReadsPerSecond),
      s3b: Math.round(m.viewer.statusFeed.s3bReadsPerSecond), s3bWrites: Math.round(m.viewer.statusFeed.s3bWritesPerSecond) }, workbookViewerReads: m.viewer.workbookReadsPerSecond, viewerMapPerSecond: Math.round(m.viewer.map), workbookViewer: m.workbook.viewerPerSecond,
    ownerPerSecond: Math.round(m.owner.perSecondIfOneComputerPerBinding), workbookOwner: Math.round(m.workbook.ownerPerSecond),
    sharedHoldReads: Math.round(m.transport.sharedHold.readsPerSecond), mergedReads: Math.round(m.transport.mergedHeartbeat.readsPerSecond),
    heldService: m.transport.heldServiceInstances, apiOnlyHeld: m.transport.apiOnlyHeldInstances, targetHeldService: m.transport.capacityTarget.heldServiceInstances,
    targetApiOnlyHeld: m.transport.capacityTarget.apiOnlyHeldInstances, recoveryReadsServerSide: m.transport.recoveryReads.serverSide, recoveryReadsConnectorRestart: m.transport.recoveryReads.connectorRestart }));
}
