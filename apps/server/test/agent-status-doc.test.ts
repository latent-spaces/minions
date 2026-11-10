// Contract C3 conformance (model-free): the status document the writers store derives the same state as the source
// documents it came from, so a projection answers what the map and MCP answer (C1).
import { expect, test } from 'vitest';
import { deriveAgentState, type AgentStateSources } from '../src/view/communication-agents.js';
import { sourcesFromStatusDoc, statusDocFromSources } from '../src/view/agent-status-doc.js';

function prng(seed: number) {
  return () => { seed = (seed + 0x6d2b79f5) | 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pick = <T>(random: () => number, items: readonly T[]) => items[Math.floor(random() * items.length)];
const NOW = 1_800_000_000_000;

// Source tuples the real writers can produce: a run always has its own presence row (startRun writes both in one
// transaction, and later contacts update it); a worker summary may belong to an older run.
function reachable(random: () => number, i: number): AgentStateSources {
  const owner = pick(random, ['p1', 'p2']), epoch = pick(random, [0, 1]);
  const agent = { name: `a${i}`, ownerProfileId: owner, connectionEpoch: epoch, revokedAt: random() < 0.05 ? NOW - 1 : null,
    focus: random() < 0.5 ? { text: 'f', updatedAt: NOW - 9 } : null, persona: { text: random() < 0.3 ? 'persona' : '' } } as never;
  const hasRun = random() < 0.9, runId = `r${i}`;
  const run = hasRun ? { runId, endedAt: random() < 0.15 ? NOW - 5_000 : null, ...(random() < 0.1 ? { mode: 'current_chat' } : {}) } as never : undefined;
  const contact = hasRun ? { runId, lastContactAt: NOW - pick(random, [3_000, 59_000, 79_000, 89_000, 91_000, 400_000]),
    phase: pick(random, ['idle', 'turn', 'backoff', 'paused', 'stopping']), phaseAt: NOW - 100_000 } as never : undefined;
  const workerKind = pick(random, ['none', 'old', 'this', 'this']);
  const worker = workerKind === 'none' ? undefined : { runId: workerKind === 'old' ? `old${i}` : runId,
    phase: pick(random, ['working', 'idle', 'waiting', 'paused', 'stopped', 'completed']),
    lastContactAt: NOW - pick(random, [2_000, 19_000, 85_000, 120_000]),
    projectPauseRevision: pick(random, [null, 3]) } as never;
  return { id: `id${i}`, agent, allowed: epoch === 1, run, contact, worker, queued: random() < 0.1, needsYou: false, sourceRevision: 0 };
}
const ctx = (s: AgentStateSources, pause?: { revision: number; requestedAt: number }) =>
  ({ allowed: (a: { connectionEpoch: number }) => a.connectionEpoch === 1 && s.allowed, queued: s.queued, ...(pause ? { pause } : {}) });

for (const pause of [undefined, { revision: 3, requestedAt: NOW - 10_000 }]) {
  test(`the stored status document derives the same state as its sources (${pause ? 'during a pause' : 'no pause'}), 2,000 tuples`, () => {
    const random = prng(pause ? 23 : 17);
    let mismatched = 0, laterFreshUntil = 0, compared = 0;
    const examples: unknown[] = [];
    for (let i = 0; i < 2_000; i++) {
      const s = reachable(random, i);
      const withPause = pause ? { ...s, pause } : s;
      const fromDoc = sourcesFromStatusDoc(s.id, statusDocFromSources(withPause), ctx(s, pause));
      // A never-run agent's document (no runId) is complete with no run (card v20) and must derive the same state.
      expect(fromDoc).not.toBeNull();
      const a = deriveAgentState(withPause, NOW), b = deriveAgentState(fromDoc!, NOW);
      compared++;
      if (a.state !== b.state || JSON.stringify(a.projectPause ?? null) !== JSON.stringify(b.projectPause ?? null)) {
        mismatched++; if (examples.length < 3) examples.push({ s: withPause, a, b });
      }
      // The document keeps the newest stored contact, so its freshUntil can only be the same or later.
      if ((b.freshUntil ?? 0) < (a.freshUntil ?? 0)) throw new Error(`freshUntil went earlier for ${s.id}`);
      if ((b.freshUntil ?? 0) > (a.freshUntil ?? 0)) laterFreshUntil++;
    }
    console.info(JSON.stringify({ statusDocConformance: { pause: !!pause, compared, mismatched, laterFreshUntil, examples } }));
    expect(mismatched).toBe(0);
  });
}

test('an incomplete document (no agent group, or a run without its runEndedAt key) sends the reader to the sources; a never-run one is complete', () => {
  const s = reachable(prng(5), 1);
  const doc = statusDocFromSources(s);
  expect(sourcesFromStatusDoc('x', { ...doc, agent: undefined }, ctx(s))).toBeNull();
  expect(sourcesFromStatusDoc('x', { ...doc, runId: doc.runId ?? 'run-x', runEndedAt: undefined }, ctx(s))).toBeNull();
  // Group-only records can have a legacy run. Only the real creation writer's explicit marker proves never-run.
  expect(sourcesFromStatusDoc('x', { agent: doc.agent } as never, ctx(s))).toBeNull();
  expect(sourcesFromStatusDoc('x', { agent: doc.agent, runEndedAt: null } as never, ctx(s))).toBeNull();
  const neverRan = sourcesFromStatusDoc('x', { agent: doc.agent, runId: null, runEndedAt: null } as never, ctx(s))!;
  expect(neverRan).not.toBeNull();
  expect(neverRan).toMatchObject({ run: undefined, contact: undefined, worker: undefined });
  // Queued is the caller's, from today's open-starts query (no start group since card v15 S4).
  expect(sourcesFromStatusDoc('x', { ...doc, runEndedAt: null }, { ...ctx(s), queued: true })!.queued).toBe(true);
  expect(sourcesFromStatusDoc('x', { ...doc, runEndedAt: null }, { ...ctx(s), queued: false })!.queued).toBe(false);
  expect(sourcesFromStatusDoc('x', undefined, ctx(s))).toBeNull();
});

test('revocation needs connectionEpoch in the agent group and the owner\'s epoch from memberships', () => {
  const s = { ...reachable(prng(9), 2), allowed: true };
  const doc = statusDocFromSources(s);
  // The owner was removed and re-added (new membership epoch): no write to the agent or presence, still revoked.
  const fromDoc = sourcesFromStatusDoc(s.id, doc, { allowed: a => a.connectionEpoch === 99 })!;
  expect(deriveAgentState(fromDoc, NOW).state).toBe('revoked');
});

// Writer timing (c1, codex-1, c8's gate-2 options). One agent per trial: a run starts at 0, the worker syncs every
// 20 s until it stops, /wait contacts every 20 s until it stops (C4-10 stores presence at most once per 60 s). Baseline
// is today's sources: presence as stored, worker summary as of the last sync. The status document's worker contactAt
// is (a) every sync, (b) throttled to once per 60 s, or (c) throttled, with the reader re-reading the authoritative
// worker summary only when the document's worker contact is stale (> 90 s old).
type Variant = 'a' | 'b' | 'c';
function trial(random: () => number, i: number) {
  const syncStop = 20 * (1 + Math.floor(random() * 15)) * 1000, waitStop = 20 * Math.floor(random() * 16) * 1000;
  const paused = random() < 0.3, pause = paused ? { revision: 3, requestedAt: 5_000 } : undefined;
  const syncs: number[] = [], waits: number[] = [];
  for (let t = 20_000; t <= syncStop; t += 20_000) syncs.push(t);
  for (let t = 20_000; t <= waitStop; t += 20_000) waits.push(t);
  const throttled = (times: number[]) => { const out: number[] = [0]; for (const t of times) if (t - out.at(-1)! >= 60_000) out.push(t); return out; };
  const presenceStored = throttled(waits), workerStored = throttled(syncs);
  const lastAt = (times: number[], t: number) => times.filter(x => x <= t).at(-1) ?? 0;
  const at = (t: number) => {
    const workerPhase = paused ? 'paused' : 'working';
    const base: AgentStateSources = { id: `t${i}`, agent: { revokedAt: null, ownerProfileId: 'p', connectionEpoch: 1, name: 'n', focus: null, persona: { text: '' } } as never,
      allowed: true, run: { runId: 'r', endedAt: null } as never,
      contact: { runId: 'r', lastContactAt: lastAt(presenceStored, t), phase: 'idle', phaseAt: 0 } as never,
      worker: { runId: 'r', phase: workerPhase, lastContactAt: lastAt([0, ...syncs], t), projectPauseRevision: paused ? 3 : null } as never,
      queued: false, needsYou: false, ...(pause ? { pause } : {}), sourceRevision: 0 };
    const doc = (contactAt: number) => {
      const d = statusDocFromSources(base);
      return sourcesFromStatusDoc(base.id, { ...d, worker: { ...d.worker!, lastContactAt: contactAt } }, { allowed: () => true, ...(pause ? { pause } : {}) })!;
    };
    const expected = deriveAgentState(base, t);
    const a = deriveAgentState(doc(lastAt([0, ...syncs], t)), t);
    const b = deriveAgentState(doc(lastAt(workerStored, t)), t);
    // (c): re-read the authoritative worker summary only when the document's worker contact is stale (> 90 s). While the
    // worker syncs, the throttled stored contact is never older than ≈80 s, so this happens only after it stops.
    const docWorkerStale = lastAt(workerStored, t) <= t - 90_000;
    // The reader stops re-reading once the authoritative worker is stale too (until the document changes).
    const authStale = lastAt([0, ...syncs], t) <= t - 90_000;
    const c = docWorkerStale ? deriveAgentState(base, t) : b;
    return { expected, a, b, c, recheck: docWorkerStale && !authStale };
  };
  // How long the throttled document trails the real last sync when the worker stops: the window (b) is wrong in.
  const earlyS = (syncs.at(-1) ?? 0) - lastAt(workerStored, syncStop);
  return { at, end: Math.max(syncStop, waitStop) + 120_000, earlyS };
}

test('writer timing: every-sync (a) and expiry re-read (c) match today; a 60 s throttle (b) shows lapses early', () => {
  const random = prng(31);
  const counts = { trials: 400, samples: 0, a: 0, b: 0, c: 0, recheckSamples: 0, bPauseUnconfirmedSamples: 0, bLagMaxS: 0, bLagMeanS: 0 };
  let lagSum = 0;
  for (let i = 0; i < 400; i++) {
    const { at, end, earlyS } = trial(random, i);
    lagSum += earlyS / 1000; counts.bLagMaxS = Math.max(counts.bLagMaxS, earlyS / 1000);
    for (let t = 1_000; t <= end; t += 1_000) {
      const r = at(t); counts.samples++;
      if (r.recheck) counts.recheckSamples++;
      for (const v of ['a', 'b', 'c'] as Variant[]) if (r[v].state !== r.expected.state) {
        counts[v]++;
        if (v === 'b' && r.b.state === 'pause_unconfirmed') counts.bPauseUnconfirmedSamples++;
      }
    }
  }
  counts.bLagMeanS = +(lagSum / 400).toFixed(1);
  console.info(JSON.stringify({ statusDocWriterTiming: counts }));
  expect(counts.a).toBe(0);
  expect(counts.c).toBe(0);
  expect(counts.b).toBeGreaterThan(0);  // the documented regression of the throttle alone
});

test('codex-1\'s tail case: syncs at 20/40/60/80 s then silence, read at 155 s', () => {
  const base = (workerContact: number): AgentStateSources => ({ id: 't', agent: { revokedAt: null } as never, allowed: true,
    run: { runId: 'r', endedAt: null } as never, contact: { runId: 'r', lastContactAt: 60_000, phase: 'idle', phaseAt: 0 } as never,
    worker: { runId: 'r', phase: 'working', lastContactAt: workerContact, projectPauseRevision: null } as never,
    queued: false, needsYou: false, sourceRevision: 0 });
  expect(deriveAgentState(base(80_000), 155_000).state).toBe('working');   // today: fresh until 170 s
  expect(deriveAgentState(base(60_000), 155_000).state).toBe('offline');   // throttled worker contact (60 s): early
});
