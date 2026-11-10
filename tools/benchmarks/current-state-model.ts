// Current-state architectures for the map/status view (card v10), compared at equal or better freshness. Model-free and
// derived: per-unit read counts come from the emulator counts cited below; change rates are inputs, not measurements.
// It answers one question: what does each design cost per state change and per viewer, and what freshness does it give?
//   A  per-tab sweep (the map before S3): every open map reads every agent's status, 60 ids every 3 s.
//   B  S3 v2 slot sweep (integrated): one block per 3 s slot per process, shared by that process's maps.
//   C  projection + delta reads: one current-state document per agent, written with each source change; maps ask for
//      "changes since my cursor" every P s. C1 runs that query once per process per project and shares it (needs a
//      process-independent cursor, c7 point 5); C2 runs it per viewer.
//   D  push: one Firestore listener per project per process over the projection, fanned out to held viewer streams
//      (SSE or long-poll recycled under Hosting's 60 s, c7 point 2). A lower bound: no listener attach reads.
//   E  c2's contract: a listener per project per process serving polls or streams from memory; linger and attaches
//      counted under random routing (listenerServed).
// Freshness here is the bound from a source commit to the map, excluding network and render.
import { WORKBOOK, SEGMENTS } from './capacity-shapes.js';

// Counted (emulator SDK reads, apps/server/test/steady-state-unit-work.test.ts; S2 integrated): a status batch reads
// 9 + 4.2 per agent; a status-feed poll pays authentication and Needs you, ≈4 (c2 status-feed-unit-work).
export const COUNTED = { statusBase: 9, statusPerAgentS2: 4.2, perPoll: 4 } as const;
export const SWEEP = { batch: 60, stepS: 3, minPassS: 15, blockAgents: 120 } as const;

export type Shape = { agents: number; viewers: number; instances: number; owners?: number };
// changesPerAgentS: how often an agent's map-visible state changes (phase, focus, run, Needs you, offline/online
// transitions). If liveness is projected as a 60 s contact stamp instead of a client-side freshUntil, add 1/60.
// viewerOpenS: mean seconds between snapshot bootstraps per viewer (tab opens); unset means not counted.
export type Load = { changesPerAgentS: number; pollS: number; projectionWritePerChange: 0 | 1; viewerOpenS?: number };

// How often an agent's projected state changes, by liveness design (c1's writer inventory): (i) every 20 s session sync
// rewrites lastContactAt and counts as a change; (ii) transitions plus freshUntil = lastContact + 90 s on every stored
// contact (≤ one per 60 s after C4-10). This is the least that keeps today's 90 s Offline bound (c4: after 60 s only 30 s
// remain, so every contact must extend it; codex-1's counterexample rules out skipping one). (iii) transitions only:
// NOT equal freshness. A silently dead agent never turns Offline, so it is a reference row for an owner lease choice
// (writes ≈ A/(D − 30 s) for an Offline bound of D s). transitionsPerAgentS is the phase/focus/run/Needs-you transition
// rate, which still needs counting from the lab trace (not the task rate).
export type Liveness = 'every-sync' | 'every-contact' | 'transitions-only';
export function changeRate(transitionsPerAgentS: number, liveness: Liveness, offlineBoundS = 90) {
  if (liveness === 'every-sync') return transitionsPerAgentS + 1 / 20;
  if (liveness === 'every-contact') return transitionsPerAgentS + 1 / Math.max(60, offlineBoundS - 30);
  return transitionsPerAgentS;
}
// Map-visible transitions per busy agent, from this lab (organic, one agent: scale-claude-8's own native transcripts,
// 26 Oct 20:18-23:59 UTC; read-only, local). Source at integration 75e5835c (controllers.mjs runTurn) reports phase
// 'turn' before and 'idle' after every turn, and each AGENT_STATUS line sends a focus update: ≈3 writes per turn
// (status lines counted ≈1 per turn). Seconds per transition, long-turn window: 5 turns in 96 min → 385 s. Short-turn: 56 turns in
// 114 min → 41 s. Weighted by the workbook's 30% busy share (idle connected sessions ≈0 transitions):
// 1/1283 to 1/137 per connected agent. One agent, one machine, a research lab: a range, not a population estimate.
export const LAB_TRANSITIONS = { busyLongS: 385, busyShortS: 41, busyShare: 0.3 } as const;
export const labTransitionRange = () => [LAB_TRANSITIONS.busyShare / LAB_TRANSITIONS.busyLongS,
  LAB_TRANSITIONS.busyShare / LAB_TRANSITIONS.busyShortS] as const;
// Cloud Run concurrency per instance for held streams: 80 on the API, 750 on the control service (R7; c7).
export const STREAM_CONCURRENCY = { api: 80, control: 750 } as const;

// Expected distinct processes a slot's V polls reach under random routing over I instances (c2, S3b).
export const reached = (instances: number, viewers: number) =>
  viewers <= 0 ? 0 : instances * (1 - (1 - 1 / instances) ** Math.max(1, viewers));

export type Design = { readsPerS: number; writesPerS: number; freshnessS: number; bootstrapReads: number;
  heldStreams: number; listeners: number };

export function perTabSweep({ agents, viewers }: Shape): Design {
  const passS = Math.max(SWEEP.minPassS, Math.ceil(agents / SWEEP.batch) * SWEEP.stepS);
  const perPass = Math.ceil(agents / SWEEP.batch) * COUNTED.statusBase + COUNTED.statusPerAgentS2 * agents;
  return { readsPerS: viewers * perPass / passS, writesPerS: 0, freshnessS: passS + SWEEP.stepS,
    bootstrapReads: perPass, heldStreams: 0, listeners: 0 };
}

export function slotSweep({ agents, viewers, instances }: Shape): Design {
  const S = 2 ** Math.ceil(Math.log2(Math.max(1, Math.ceil(agents / SWEEP.blockAgents))));
  const passS = Math.max(5, S) * SWEEP.stepS;
  const perPass = S * COUNTED.statusBase + COUNTED.statusPerAgentS2 * agents;
  const polls = viewers > 0 ? viewers * S / passS : 0;
  return { readsPerS: reached(instances, viewers) * perPass / passS + polls * COUNTED.perPoll, writesPerS: 0,
    freshnessS: passS + SWEEP.stepS, bootstrapReads: perPass, heldStreams: 0, listeners: 0 };
}

// A delta query returns the changed projection documents since the cursor: max(1, changes) reads (Firestore bills one
// read for an empty query result).
const deltaReads = (changesInWindow: number) => Math.max(1, changesInWindow);

export function projectionDelta({ agents, viewers, instances }: Shape, load: Load, shared: boolean): Design {
  const changes = agents * load.changesPerAgentS;
  const queriers = shared ? reached(instances, viewers) : viewers;
  const queryReads = queriers * deltaReads(changes * load.pollS) / load.pollS;
  const pollOverhead = viewers / load.pollS * COUNTED.perPoll;
  // Each tab open (or a resume past the tombstone window) reads every agent from Firestore (c1 2b).
  const bootstrap = load.viewerOpenS ? viewers * agents / load.viewerOpenS : 0;
  return { readsPerS: viewers > 0 ? queryReads + pollOverhead + bootstrap : 0, writesPerS: changes * load.projectionWritePerChange,
    freshnessS: load.pollS, bootstrapReads: agents + COUNTED.perPoll, heldStreams: 0, listeners: 0 };
}

export function push({ agents, viewers, instances }: Shape, load: Load): Design {
  const changes = agents * load.changesPerAgentS;
  const listeners = reached(instances, viewers);
  // Lower bound: listeners = reached(I, V) with no attach reads. listenerServed below counts linger and attaches.
  // A listener is charged one read per changed document it receives; viewers on held streams add no reads, only the
  // per-connection authentication (perPoll) each time a stream is recycled under Hosting's 60 s limit.
  // Each recycle lands on a random instance (c7): it re-authenticates and resumes from its cursor, at least one read
  // for the (usually empty) gap since its last event; the instance's project listener is assumed already running.
  const recycleS = 45;
  return { readsPerS: viewers > 0 ? listeners * changes + viewers / recycleS * (COUNTED.perPoll + 1) : 0,
    writesPerS: changes * load.projectionWritePerChange, freshnessS: 1, bootstrapReads: agents + COUNTED.perPoll,
    heldStreams: viewers, listeners };
}

// c2's contract (current-state-contract.md at 70097df4, C3/C4/C8): one listener per project per process on agentStatus,
// with snapshots and deltas served from that process's memory, so a request reads no per-agent documents. A listener
// lives while a request is on its process and then lingers L s (PROJECT_LISTENER_LINGER_MS = 30 s at 5631bbcb).
// Under random routing, requests reach a process at λ = V/(interval·I). A listener is alive with probability
// 1 − e^(−λ·window), and a request that finds none attaches one, reading every agent (c1 2a). So a busy project keeps a
// listener on nearly every instance (E → I, not reached(I, V)). A quiet one keeps re-attaching. transport 'poll' asks
// every pollS; 'push' holds a stream for recycleS and then reconnects to a random instance.
export const LINGER_S = 30;
export const STALL_PROBE_S = 10;
export const PAGE_SIZE = 500;
export const ACCESS_READS = { owner: 5, member: 8 } as const;  // operators + project doc per answer (c3 e8a68b55)
// c3's readDeps runs activeRecipientOperators over ALL row owners plus the viewer (c1): profile + membership + fence per
// distinct person d, + the project doc inside it, + the project doc for pause: 3d + 2. Fits the measured 5 (d = 1) and
// 8 (d = 2). The workbook assumes one owner per project (capacity-shapes ownersPerProject).
export const accessReadsPerAnswer = (owners: number, viewerIsOwner: boolean) => 3 * (owners + (viewerIsOwner ? 0 : 1)) + 2;  // current-state-core.ts pageSize default (c2)
// c2's core at 52313372 (c2, c9 on a20f72a5): an answer lists each changed id once, so pages = ⌈D/P⌉ over D DISTINCT ids
// changed since the base (≤ n). Periodic writers (each agent's change interval ≥ the poll, e.g. every-sync's 20 s) do
// not repeat within a window, so D = min(k, n) (c9, c2); bursty or random writers repeat, D = n(1 − e^(−k/n)). A page
// walks the log or the ids after the cursor, whichever is shorter, and stops at P+1 found, so a large delta is capped
// near n to 2n: ≈ ≤ min(D·⌈D/P⌉, 2n + pages), approximate, not strict (c2: an even half-changed project sums ≈10,500).
// c9 measured (n = 5,000, P = 500) 762 → 1,524; 2,500 → 9,501; 5,000 → 9,508; 50,000 writes on 5,000 ids → 5,009 visits.
const distinct = (k: number, n: number, periodic: boolean) => !Number.isFinite(n) ? k : periodic ? Math.min(k, n) : n * (1 - Math.exp(-k / n));
const deltaVisits = (k: number, n = Infinity, periodic = true) => {
  const d = distinct(k, n, periodic), pages = Math.max(1, Math.ceil(d / PAGE_SIZE));
  return Math.min(d * pages, 2 * n + pages);
};
const resetShare = (lambda: number, windowS: number, intervalS: number) =>
  Math.min(1, Math.exp(-lambda * windowS) * (1 + lambda * intervalS));
export function listenerServed({ agents, viewers, instances, owners = 1 }: Shape, load: Load, transport: 'poll' | 'push',
  lingerS = LINGER_S, recycleS = 45, probeReads = 1, reattachS = STALL_PROBE_S, incompleteShare = 0): Design & { attachesPerS: number; resetShare: number; recordsPerRequest: number;
  stallProbeReadsPerS: number; followUpReadsPerS: number; resetPagingReadsPerS: number; idleReattachReadsPerS: number; rowVisitsPerS: number; indexedRowVisitsPerS: number; onePassRowVisitsPerS: number; accessReadsPerS: number; heldDerivationsPerS: number; incompleteRereadReadsPerS: number } {
  if (viewers <= 0) return { readsPerS: 0, writesPerS: 0, freshnessS: 0, bootstrapReads: 0, heldStreams: 0, listeners: 0, attachesPerS: 0, resetShare: 0, recordsPerRequest: 0, stallProbeReadsPerS: 0, followUpReadsPerS: 0, resetPagingReadsPerS: 0, idleReattachReadsPerS: 0, rowVisitsPerS: 0, indexedRowVisitsPerS: 0, onePassRowVisitsPerS: 0, accessReadsPerS: 0, heldDerivationsPerS: 0, incompleteRereadReadsPerS: 0 };
  const intervalS = transport === 'poll' ? load.pollS : recycleS;
  const windowS = transport === 'poll' ? lingerS : recycleS + lingerS;
  const lambda = viewers / (intervalS * instances);
  const listeners = instances * (1 - Math.exp(-lambda * windowS));
  const attachesPerS = instances * lambda * Math.exp(-lambda * windowS);
  const changes = agents * load.changesPerAgentS;
  return { readsPerS: listeners * changes + attachesPerS * agents + viewers / intervalS * COUNTED.perPoll,
    writesPerS: changes * load.projectionWritePerChange, freshnessS: transport === 'poll' ? load.pollS : 1,
    bootstrapReads: COUNTED.perPoll, heldStreams: transport === 'push' ? viewers : 0, listeners, attachesPerS,
    // C5 with c9's W0 rule (4d0fdfe0): a request served by a listener that attached after the client's cursor must
    // resync, including a listener another viewer attached since this client's last request (c9's review). Share ≈
    // e^(−λ·window)·(1 + λ·interval): the no-listener share plus listeners younger than one interval. Checked against
    // c9's simulation (c52953e8, listener lag included): 0.50/0.49, 0.47/0.45, 0.22/0.20, 0.045/0.059 (model/sim),
    // so within ≈25%. A resync is served from memory (no extra reads) but sends records: a full snapshot (n),
    // against changes·interval for a normal delta. c9's proposal (changes since cursor + live id set) sends ids instead.
    // Listener-stall rule (c3 2853fe71, adopted by c2 as A + D): when a listener's W has not moved for STALL_PROBE_S
    // and a request arrives, one limit-1 read of the newest statusAt. Upper bound one probe per listener per T, scaled by
    // the chance a project's changes leave W idle that long (Poisson, e^(−changes·T)). Reported separately: add it to
    // readsPerS for the total.
    // probeReads: 2 while the probe also orders by lastContactAt (c3 8a60579a), 1 once every writer sets statusAt.
    stallProbeReadsPerS: probeReads * listeners * Math.exp(-changes * STALL_PROBE_S) / STALL_PROBE_S,
    // Delta follow-ups (c1): when one interval's changes exceed a page (c2's core, PAGE_SIZE), the client re-requests at
    // once on more:true, paying the per-request authentication and Needs you again. Reported separately, like the probe.
    // Mean changes per interval, so a lower bound: Poisson bursts near a page also overflow (c1).
    followUpReadsPerS: transport === 'poll' ? viewers / intervalS * Math.max(0, Math.ceil(changes * intervalS / PAGE_SIZE) - 1) * COUNTED.perPoll : 0,
    // Reset paging (c1): a resync sends the full snapshot, ⌈agents/PAGE_SIZE⌉ − 1 extra requests at perPoll each, for the
    // resetShare of requests. Served from memory; the reads are the per-request auth only.
    resetPagingReadsPerS: viewers / intervalS * resetShare(lambda, windowS, intervalS) * (Math.ceil(agents / PAGE_SIZE) - 1) * COUNTED.perPoll,
    // Contract v2.3 point 5 (a) (c2): a listener whose W has not moved for reattachS re-attaches, reading every agent, at
    // most once per reattachS per listener with readers. Replaces the probe: same Poisson idle chance, n reads, not 1-2.
    // Freshness under a silent stall is then ≤ reattachS (+ attach time), not the listener lag.
    idleReattachReadsPerS: listeners * Math.exp(-changes * reattachS) / reattachS * agents,
    // c2's core at 67e82142 scans and sorts every doc in memory on a request unless the cursor is at P = W (the idle path):
    // row visits are CPU, not reads (c1). Non-idle share 1 − e^(−changes·interval). c25aff83 replaces this with an id index
    // and a (rev, id) log, so a delta visits what it returns (measured by c2: 10 changes → 10 visits); this term is
    // then the 67e82142 reference, not the design.
    rowVisitsPerS: viewers / intervalS * agents * (1 - Math.exp(-changes * intervalS)),
    // c25aff83 (c2's id index + (rev, id) log), per c9: a delta of k changes re-walks the log from its base on each page,
    // k·⌈k/P⌉ visits; a reset walks ids, ≈ n + pages. Evaluated at mean k: k·⌈k/P⌉ is convex, so Poisson k slightly
    // under-counts (negligible at k ≈ 762, larger near page boundaries and in bursts; long disconnects are quadratic in
    // k/P), capped near n to 2n by c2's 52313372 (distinct ids, id walk; see deltaVisits). c2's dedup fix (52313372, c1/c13/c9 ✓) makes a
    // replay into the same projection a no-op, so the replay-growth case no longer applies. onePass: a per-delta cursor
    // into the log (c6 point 5), k + pages; not what 52313372 chose.
    indexedRowVisitsPerS: viewers / intervalS * ((1 - resetShare(lambda, windowS, intervalS)) * deltaVisits(changes * intervalS, agents, 1 / load.changesPerAgentS >= intervalS)
      + resetShare(lambda, windowS, intervalS) * (agents + Math.ceil(agents / PAGE_SIZE))),
    onePassRowVisitsPerS: viewers / intervalS * ((1 - resetShare(lambda, windowS, intervalS)) * (changes * intervalS + Math.ceil(changes * intervalS / PAGE_SIZE))
      + resetShare(lambda, windowS, intervalS) * (agents + Math.ceil(agents / PAGE_SIZE))),
    // c3's v2.3 endpoint (e8a68b55): every answer re-reads access and pause in one read-only transaction,
    // activeRecipientOperators + the project doc, so no listener holds authority. c8-measured operator reads (fixture,
    // §4h): 4 for the owner, 7 for another member, + 1 project doc; one owner per project, the rest members. Equal to
    // today's map (same operators + project doc per answer); a cost only versus a listener-held-authority design (c1).
    accessReadsPerS: viewers / intervalS * (Math.min(owners, viewers) * accessReadsPerAnswer(owners, true)
      + Math.max(0, viewers - owners) * accessReadsPerAnswer(owners, false)) / viewers,
    // And every complete answer derives each held row twice (derive(E) vs derive(now)): an O(n) CPU scan per answer
    // until codex-1's timer index replaces it. CPU, not reads.
    heldDerivationsPerS: viewers / intervalS * 2 * agents,
    // c3/c10 on e8a68b55: every status doc that is not yet complete (missing groups the CS2a agent-group writers would
    // add) is re-read from its sources and re-sent on every complete answer, at today's per-agent status cost. Today that
    // is the whole roster (incompleteShare 1); 0 once every writer fills the doc. A staging cost: the endpoint costs at
    // least today's map per answer until the writers land.
    incompleteRereadReadsPerS: viewers / intervalS * incompleteShare * agents * COUNTED.statusPerAgentS2,
    resetShare: resetShare(lambda, windowS, intervalS),
    recordsPerRequest: resetShare(lambda, windowS, intervalS) * agents + (1 - resetShare(lambda, windowS, intervalS)) * changes * intervalS };
}

// codex-1's matched state-only replay (ca31cd9a, local emulator, SDK logical reads; 1 process, 1 project, 20 agents with
// one owner, 8 rounds, 5 source hints), decomposed. Full map, per answer: assertMembership 3 units / 3 calls plus
// communicationAgents 70 units, 10 calls (13 for the owner). Per call, measured by c8 on codex-1's composite (52a09c08 +
// 6e46753d + 4d657b37, presence carries the worker summary): roster 20 + presence 20 + runs 20 + project 1 + queued-start
// queries 2, then for the owner operators 4 + Needs-you queries 3 (3 calls), for another viewer operators 7 (profile,
// membership and fence for 2 people) and no Needs-you query. Equal totals by coincidence of those terms. On ca31cd9a's own
// tree (older reader: pointer and session batches) the same read is 110 units in 15 calls. Shared reference: per hint,
// one coherent read-only capture of every source; per answer, assertMembership plus, for the owner only, the private
// query in chunks of 9 ids. Capture per agent: roster row, run, presence, pointer, session = 5 units; fixed: project 1 +
// activeRecipientOperators 4 (one owner) + the queued-start query, one chunk per 10 ids per owner. The probe fetches
// run/presence/pointer/session with one tx.get each, so calls ≈ units; a tx.getAll would make it a handful of calls.
export const MATCHED = { agents: 20, rounds: 8, hints: 5, membership: 3, fullMapUnits: 70, fullMapCalls: 10, ownerExtraCalls: 3,
  capturePerAgent: 5, captureFixed: 5, queuedChunk: 10, privateChunk: 9 } as const;
export const captureUnits = (agents: number) => MATCHED.capturePerAgent * agents + MATCHED.captureFixed + Math.ceil(agents / MATCHED.queuedChunk);
// Calls: one roster query, one project get, 4 operator calls, queued chunks, then per agent 4 gets (run/presence/pointer,
// session) unbatched, or 2 getAll calls in total if batched (not measured: a projection of the same reads).
export const captureCalls = (agents: number, batched = false) => 1 + 1 + 4 + Math.ceil(agents / MATCHED.queuedChunk) + (batched ? 2 : 4 * agents);
// Which reader the full-map baseline is (c1): per answer, 20 agents, membership included, all c8-measured on the
// emulator except where noted. ca31cd9a's recorded run = the presence-first composite (its JSON: 52a09c08 + 6e46753d +
// 4d657b37) = 73. Integration default at ef394a09 (pointer carries the summary, so pointers are batched, no session
// read) = 93. ca31cd9a's own tree (older reader: pointer and session batches) = 113. W1 + c5's 600641bc and R2/W3 are
// not measured here.
export const FULL_MAP_BY_READER = { ca31Composite: 73, integrationDefault: 93, ca31OwnTree: 113 } as const;
export function matchedReplay(viewers: number, batched = false, fullPerAnswer: number = FULL_MAP_BY_READER.ca31Composite) {
  const { rounds, hints, membership, agents } = MATCHED, answers = rounds * viewers, ownerPrivate = rounds * Math.ceil(agents / MATCHED.privateChunk);
  return {
    full: { units: answers * fullPerAnswer, calls: answers * (membership + MATCHED.fullMapCalls) + rounds * MATCHED.ownerExtraCalls },
    shared: { units: hints * captureUnits(agents) + answers * membership + ownerPrivate,
      calls: hints * captureCalls(agents, batched) + answers * membership + ownerPrivate },
  };
}
// Break-even for read units: sharing wins when captures cost less than the per-answer reads they replace, i.e. hints per
// answer < fullMapUnits / captureUnits (0.65 at 20 agents). The replay has 5 hints over 8 answers per viewer, so at one
// viewer the two paths tie (583 vs 584). Each hint recaptures every agent; a hint scoped to the changed agents costs
// 5·k + fixed instead, which is what a production feed would need (5,000 agents: 25,505 units per full capture).
// c9's review of ca31cd9a: the replay captures only on rounds the harness knows changed (an oracle). Without a durable
// notification, equal freshness needs a capture every round (8, not 5). Two listener variants (c2's contract, one
// process), derived, not measured:
// (i) completeProjection: every map input in one listened doc per agent, which is NOT built (gate 2 (a) moves only the
//     worker group; focus, agent/revocation, queued starts and membership live elsewhere). One attach per epoch (twice:
//     bootstrap and the cold epoch) at 20 reads + ≈5 for project/members/fences/operator profiles (c9), one read per
//     changed doc (1 + 10 syncs), one 2-read stall probe across the 600 s gap; 11 projection writes. Under gate 2 (a) the
//     writers write presence in their own transaction, so no projector reads; a separate projector would add its source
//     reads per change (c1 (a)). The round-6 fence change re-derives, it does not reset (contract v2.3 point 4).
// (ii) todaysSources: listeners on today's documents. Attach = one full capture (107) per epoch; changed = every staged
//     source write the listeners see (ca31's writers: 23, 22 sync docs + 1 fence).
export function matchedReplayAlternatives(viewers: number) {
  const { rounds, membership, agents } = MATCHED, answers = rounds * viewers, ownerPrivate = rounds * Math.ceil(agents / MATCHED.privateChunk);
  const perAnswer = answers * membership + ownerPrivate, changed = 1 + 10, probe = 2, epochs = 2, dependencyAttach = 5, sourceWrites = 23;
  return { captureEveryRound: rounds * captureUnits(agents) + perAnswer,
    completeProjection: { units: epochs * (agents + dependencyAttach) + changed + probe + perAnswer, projectionWrites: changed },
    todaysSources: { units: epochs * captureUnits(agents) + sourceWrites + probe + perAnswer, projectionWrites: 0 } };
}
export const hintsPerAnswerBreakEven = (agents = MATCHED.agents) => MATCHED.fullMapUnits / captureUnits(agents);

// Gate 1, both designs scored on their own contracts (c6, 03:24Z). Derived, not measured; CPU visits, not reads.
// (a) head-only pinned floor (c2 core c25aff83): per (project, process) n heads + a (rev, id) log ≤ 2n; any replica with
//     W ≥ P serves any page, so routing is free; a delta of k costs k·⌈k/P⌉ visits (c9); notReady retries need a lag
//     distribution (open).
// (b) bounded pinned sessions (codex-1 prototype, 20ca573e→ab368268): an answer over one page pins its rendered rows in a
//     process-local session (FIFO, maxSessions, no TTL), and cursors carry a process-local epoch and seq. A continuation
//     or delta that lands on another process resyncs (snapshot_session_unavailable / cold_replica_epoch, c7 finding 1), so
//     under random routing a request finds its process w.p. ≈ 1/I and a p-page answer completes w.p. (1/I)^(p−1). With
//     affinity a delta visits k replay entries once. Replay ring ≥ changes/s × the longest gap it must bridge.
// ROW_BYTES: ca31cd9a's state-only JSON, 20,008 bytes / 160 rows ≈ 125 B per row; JS heap per row is higher (unmeasured).
export const ROW_BYTES = 125;
// c1 (d9a704de prototype, scratch, Node 25.7): ≈254 B is the JSON length of one synthetic row with a 200-char pad, NOT
// measured heap. Heap per pinned row is unmeasured; figures from either constant are JSON-size estimates.
export const SESSION_ROW_BYTES_SYNTHETIC_JSON = 254;
// routing: 'random' (no affinity), 'continuation' (pages stick to the session's process, deltas land anywhere; c7's
// c0b1413a middle mode, 14/16), 'viewer' (full viewer affinity, 13/16; c7 found deltas then lag with the owning process).
// Under 'viewer' a viewer moves process only on a handoff (scale event, restart, deploy, Hosting reroute): one
// re-bootstrap of n rows per handoff, every handoffS seconds per viewer (unmeasured input; default 1 h).
export function gate1Designs({ agents, viewers, instances }: Shape, load: Load,
  o: { routing: 'random' | 'continuation' | 'viewer'; maxSessions?: number; gapS?: number; handoffS?: number; pageDelayS?: number; waveViewers?: number }) {
  const changes = agents * load.changesPerAgentS, k = changes * load.pollS, requestsPerS = viewers / load.pollS;
  const pages = (rows: number) => Math.max(1, Math.ceil(rows / PAGE_SIZE));
  const head = { memoryBytes: 3 * agents * ROW_BYTES, visitsPerS: requestsPerS * deltaVisits(k, agents, 1 / load.changesPerAgentS >= load.pollS), resyncsPerS: 0, multiPageCompletes: 1 };
  const handoffResyncsPerS = o.routing === 'viewer' ? viewers / (o.handoffS ?? 3600) : 0;
  // Share of delta requests that reach the process holding the cursor's epoch.
  const local = o.routing === 'viewer' ? 1 : 1 / instances;
  const resyncsPerS = requestsPerS * (1 - local) + handoffResyncsPerS;
  // A resync re-bootstraps every agent, and an n-row answer pins an n-row session; a k-row delta over one page pins k.
  const sessionRows = local * (k > PAGE_SIZE ? k : 0) + (1 - local) * agents;
  const perProcess = o.routing === 'viewer' ? viewers / instances : viewers;
  // c7 (review of 56a5c4dd): every multi-page ANSWER pins a session and keeps it until FIFO eviction, so with any
  // multi-page traffic the slots fill: sessions = maxSessions. Slot lifetime = maxSessions / multi-page answers per s per
  // process; a continuation slower than that is evicted and restarts with an n-row first read (launch gate:
  // maxSessions ≥ multi-page answers/s × p99 continuation delay).
  const multiPageAnswersPerS = sessionRows ? requestsPerS / (o.routing === 'viewer' ? instances : 1) : 0;
  const sessions = multiPageAnswersPerS ? (o.maxSessions ?? Infinity) : 0;
  const slotLifetimeS = multiPageAnswersPerS ? (o.maxSessions ?? Infinity) / multiPageAnswersPerS : Infinity;
  // c7 (review of eee1ee1e): a session is not deleted on its last page, only by FIFO eviction, and every multi-page
  // first read pins all n rows. After a reconnect wave of ≥ maxSessions viewers on a process, maxSessions × n rows stay
  // resident until later answers push them out; in steady state completed bootstrap sessions compete with delta sessions
  // for slots. When in-flight answers exceed maxSessions, sessions are evicted mid-answer and restart (rate unmeasured).
  // Deleting a session on its last page (codex-1's call) would bound this to in-flight answers.
  const bootstrapWaveBytes = Math.min(o.maxSessions ?? Infinity, perProcess) * (pages(agents) > 1 ? agents : 0) * ROW_BYTES;
  // c1's defect (d9a704de): FIFO eviction of in-progress sessions livelocks once concurrent multi-page answers exceed
  // maxSessions (100 concurrent bootstraps at 64 slots: 0 completed in 30 rounds, 792 resyncs). In flight = answers/s ×
  // (pages − 1) × the delay between page requests; a reconnect wave of waveViewers bootstraps per process at once.
  const inFlight = multiPageAnswersPerS * (pages(sessionRows || 1) - 1) * (o.pageDelayS ?? 0.3);
  const waveInFlight = o.waveViewers ?? perProcess;
  // For TODAY's FIFO prototype: true means this load livelocks; false means it stays under the slot count, not that the
  // defect is fixed. The default wave is one process's share of viewers; pass waveViewers for a concentrated reconnect.
  const fifoLivelockToday = { steady: inFlight > (o.maxSessions ?? Infinity), wave: pages(agents) > 1 && waveInFlight > (o.maxSessions ?? Infinity) };
  // codex-1's never-evict repair (0fd7ba66): in-progress sessions are kept, the oldest completed one is recycled, and a
  // new multi-page answer otherwise waits busy. A wave of W bootstraps of p pages on S slots then drains in ≈ ⌈W/S⌉ × p
  // page rounds, and multi-page deltas of connected viewers wait busy behind it (source→viewer lag, c7). Measured
  // (U10, Node 24): W=100 all complete with 684 busy waits; W=200 completes over the 2× work bound; W=500 384/500 after
  // 122 rounds and 31,880 waits. A drain MEAN: with no admission order one viewer's tail wait is unbounded (c7), and
  // busy-retry work grows ≈W²/maxSessions.
  const waveDrainRounds = pages(agents) > 1 ? Math.ceil(waveInFlight / (o.maxSessions ?? Infinity)) * pages(agents) : 0;
  const pinned = { inFlight, fifoLivelockToday, waveDrainRounds, memoryBytes: (agents + sessions * sessionRows) * ROW_BYTES, bootstrapWaveBytes, slotLifetimeS, replayEntries: changes * (o.gapS ?? 60),
    visitsPerS: requestsPerS * (local * k + (1 - local) * agents) + handoffResyncsPerS * agents, resyncsPerS,
    // Continuations stick except under 'random', where each later page lands on the session's process w.p. 1/I.
    multiPageCompletes: o.routing === 'random' ? (1 / instances) ** (pages(agents) - 1) : 1 };
  return { headOnly: head, pinnedSessions: pinned };
}

// Queued starts on the dark endpoint (c3 6cb11137 vs c2's contract 7cddc86d; c6 asked to reconcile). Per answer:
// 'perOwner' reuses today's chunked query, ⌈agents of the owner / 12⌉ queries per owner, each ≥ 1 billed read (c3:
// 15 + ⌈n/12⌉ in unit work); 'project' is one query, projectId == P and state in [pending, accepted], with the owner rule
// in memory: max(1, open starts). Equality-only, so it is served by merging the automatic single-field indexes (no
// composite needed; close-work.ts:22 already runs projectId + state).
export function queuedReadsPerAnswer(agents: number, owners: number, mode: 'perOwner' | 'project', openStarts = 0) {
  return mode === 'project' ? Math.max(1, openStarts) : owners * Math.ceil(agents / owners / 12);
}

// Multi-project listener cap (supervisor 04:26Z: 100 and 1,000 small projects beside a hot one). Source at integration
// a697f708 (current-state.ts): at most CURRENT_STATE_MAX_PROJECTS = 100 listeners per process; NO eviction. A listener
// is freed only after 30 s (CURRENT_STATE_LINGER_MS) with no reader, or on failure; a project arriving while 100 are
// held gets fallback: true on every request (C8). So under saturation it is first-come-first-held, not a fair share: a
// project that keeps polling keeps its slot, and the late ones (possibly the hot project) are starved, not rotated.
// Per process, project p is held w.p. 1 − e^(−λp·(linger + interval)), λp = Vp/(interval·I) (random routing). This
// predicts what the acceptance harness should count; it is derived, not measured. Labels (c9, c7): every process admits
// in the same list order, so all starve the same projects, a worst-case bound (under random routing a project can be
// held on some processes and starved on others: per-project fallback is partial); `used += active` counts part-time
// projects as fractions of a slot, an expected value (a live project holds a whole slot, so it can saturate earlier);
// and before c3's replacement-linger fix, an abandoned stall re-attachment has no linger and is never freed
// (codex-3's leak, confirmed by c7), so "freed only by linger or failure" is optimistic until then (fix: c3 ddc280ef).
export const CURRENT_STATE_MAX_PROJECTS = 100;
export function listenerCapShape(projects: { agents: number; viewers: number }[], instances: number, o: { cap?: number; lingerS?: number; pollS?: number } = {}) {
  const cap = o.cap ?? CURRENT_STATE_MAX_PROJECTS, window = (o.lingerS ?? LINGER_S) + (o.pollS ?? 3), poll = o.pollS ?? 3;
  const active = projects.map(p => 1 - Math.exp(-p.viewers / (poll * instances) * window));
  const demand = active.reduce((a, b) => a + b, 0);  // listeners a process would hold with no cap
  // Arrival order: in list order. Held while cumulative demand ≤ cap; the rest are refused on that process.
  let used = 0; const held = active.map(a => { const ok = used + a <= cap + 1e-9; if (ok) used += a; return ok; });
  const requests = projects.reduce((n, p) => n + p.viewers / poll, 0);
  const fallbackRequests = projects.reduce((n, p, i) => n + (held[i] ? 0 : p.viewers / poll), 0);
  return { demandPerProcess: demand, occupancy: Math.min(cap, used), saturated: demand > cap, starvedProjects: held.filter(h => !h).length,
    fallbackShare: requests ? fallbackRequests / requests : 0,
    // Each held listener reads its project's agents once on attach (n); a starved project's requests keep today's map.
    seedReads: projects.reduce((n, p, i) => n + (held[i] ? instances * active[i] * p.agents : 0), 0),
    // Re-attach churn (c9): a held part-time project frees and re-attaches at λ·e^(−λ·window) per process
    // (listenerServed's attach rate), an n-doc seed each time.
    reattachSeedReadsPerS: projects.reduce((n, p, i) => { const l = p.viewers / (poll * instances);
      return n + (held[i] ? instances * l * Math.exp(-l * window) * p.agents : 0); }, 0) };
}

// Listener CPU per process (c11 d7b147cd, local emulator, Node SDK, bare onSnapshot over the status docs, control
// subtracted): ≈164 ms per snapshot at 5,000 docs and ≈30 ms at 1,000, over ≈180 snapshots in 90 s (contacts batched
// once a second + 1 phase write a second). Linear in n: ≈32 µs per doc per snapshot (c8's division). So a project listener
// costs snapshots/s × n × 32 µs of CPU per process holding it. The snapshot rate under production's one commit per
// contact is the unknown: between one per second (coalesced) and one per commit; c11's single-commit run stalled the
// emulator (inconclusive). An unverified managed-cloud launch gate; local Node CPU, not a Cloud Run vCPU.
export const LISTENER_CPU_US_PER_DOC_SNAPSHOT = 32;
export const listenerCpuCores = (docs: number, snapshotsPerS: number) => snapshotsPerS * docs * LISTENER_CPU_US_PER_DOC_SNAPSHOT / 1e6;

export function compareShape(shape: Shape, load: Load) {
  return { perTab: perTabSweep(shape), slot: slotSweep(shape), deltaShared: projectionDelta(shape, load, true),
    deltaPerViewer: projectionDelta(shape, load, false), push: push(shape, load),
    listenerPoll: listenerServed(shape, load, 'poll'), listenerPush: listenerServed(shape, load, 'push') };
}

// Month 6 of the workbook at its normal peak (FM1 populations): every project with its segment's viewers, I instances.
export function month6(load: Load, instances = 59) {
  const monthly = WORKBOOK.monthlyProjects[5];
  const totals: Record<keyof ReturnType<typeof compareShape>, { readsPerS: number; writesPerS: number; heldStreams: number }> =
    { perTab: zero(), slot: zero(), deltaShared: zero(), deltaPerViewer: zero(), push: zero(), listenerPoll: zero(), listenerPush: zero() };
  for (const s of SEGMENTS) {
    const projects = Math.ceil(monthly[s] * WORKBOOK.peakFraction), viewers = WORKBOOK.viewersPerProject[s];
    // V < 1 is the share of projects with one viewer.
    const watched = viewers < 1 ? projects * viewers : projects, perProject = Math.max(1, viewers);
    const result = compareShape({ agents: WORKBOOK.sessionsPerProject[s], viewers: perProject, instances }, load);
    for (const k of Object.keys(totals) as (keyof typeof totals)[]) {
      totals[k].readsPerS += watched * result[k].readsPerS;
      totals[k].writesPerS += projects * (WORKBOOK.sessionsPerProject[s] * load.changesPerAgentS * load.projectionWritePerChange) * (k === 'perTab' || k === 'slot' ? 0 : 1);
      totals[k].heldStreams += watched * result[k].heldStreams;
    }
  }
  return { ...totals, streamInstances: { api: Math.ceil(totals.push.heldStreams / STREAM_CONCURRENCY.api),
    control: Math.ceil(totals.push.heldStreams / STREAM_CONCURRENCY.control) } };
}
const zero = () => ({ readsPerS: 0, writesPerS: 0, heldStreams: 0 });

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const r = (x: number) => Math.round(x);
  for (const liveness of ['every-sync', 'every-contact', 'transitions-only'] as const) for (const t of [1 / 600, 1 / 120]) {
    const changesPerAgentS = changeRate(t, liveness);
    const load: Load = { changesPerAgentS, pollS: 3, projectionWritePerChange: 1 };
    const flagship = compareShape({ agents: 5000, viewers: 100, instances: 59 }, load);
    const m = month6(load);
    console.log(JSON.stringify({ liveness, transitionsPerAgentS: t, flagship: Object.fromEntries(Object.entries(flagship).map(([k, v]) => [k, { reads: r(v.readsPerS), writes: r(v.writesPerS), freshnessS: v.freshnessS }])),
      month6: Object.fromEntries(Object.entries(m).filter(([k]) => k !== 'streamInstances').map(([k, v]) => [k, { reads: r((v as { readsPerS: number }).readsPerS), writes: r((v as { writesPerS: number }).writesPerS) }])), streamInstances: m.streamInstances }));
  }
}
