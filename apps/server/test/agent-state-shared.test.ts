// P1 (current-state contract): the app map and MCP find_agents derive each agent's status from the same sources with
// the same function. Randomized source tuples on the emulator, read through both real paths, must agree agent by agent.
import { randomUUID } from 'node:crypto';
import { beforeEach, expect, test } from 'vitest';
import { V2_LIMITS } from '../src/config.js';
import { agents, inProject } from '../src/firestore.js';
import { webAgentStarts } from '../src/owner/web-agent-starts.js';
import { statusDocFromSources } from '../src/view/agent-status-doc.js';
import { setCanonicalStatus } from './canonical-status-fixture.js';
import { communicationAgents, deriveAgentState, type AgentStateSources } from '../src/view/communication-agents.js';
import { findAgents } from '../src/v2/agents.js';
import { resetEmulator, seed, seedRuntime, TEST_PROJECT } from './helpers.js';

beforeEach(resetEmulator);
const scope = <T>(fn: () => T) => inProject(TEST_PROJECT, fn);
const FRESH = V2_LIMITS.runActiveSeconds * 1000;

function prng(seed: number) {
  return () => { seed = (seed + 0x6d2b79f5) | 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pick = <T>(random: () => number, items: readonly T[]) => items[Math.floor(random() * items.length)];

async function seedRandomSources(count: number, seedValue: number, now: number) {
  const random = prng(seedValue);
  const f = await seed({ profiles: [{ name: 'Viewer', email: `state-viewer-${seedValue}@example.test` }],
    agents: Array.from({ length: count }, (_, i) => ({ person: 0, name: `agent-${String(i).padStart(3, '0')}` })) });
  const ids = f.agents.map(a => a.agentId);
  await scope(async () => {
    for (const id of ids) {
      const runId = randomUUID(), runKind = pick(random, ['none', 'active', 'active', 'active', 'ended'] as const);
      const agent = (await agents().doc(id).get()).data()!;
      const run = runKind === 'none' ? undefined : { runId, endedAt: runKind === 'ended' ? now - 5_000 : null,
        ...(random() < 0.1 ? { mode: 'current_chat' as const } : {}) };
      const presenceKind = pick(random, ['none', 'other', 'this', 'this', 'this'] as const);
      const contact = presenceKind === 'none' ? undefined : { runId: presenceKind === 'other' ? randomUUID() : runId,
        lastContactAt: now - pick(random, [5_000, 59_000, 79_000, 89_000, 91_000, 400_000]),
        phase: pick(random, ['idle', 'turn', 'backoff', 'paused', 'stopping'] as const), phaseAt: now - 100_000 };
      const workerKind = pick(random, ['none', 'other', 'this', 'this'] as const);
      const worker = workerKind === 'none' ? undefined : {
        runId: workerKind === 'other' ? randomUUID() : runId,
        phase: pick(random, ['working', 'idle', 'waiting', 'paused', 'stopped', 'completed'] as const),
        lastContactAt: now - pick(random, [3_000, 19_000, 85_000, 120_000]),
        projectPauseRevision: pick(random, [null, 3]) };
      await setCanonicalStatus(id, statusDocFromSources({ id, agent, allowed: true, run, contact, worker,
        queued: false, needsYou: false, sourceRevision: 0 } as AgentStateSources));
      if (random() < 0.1) await webAgentStarts.doc(randomUUID()).set({ profileId: f.personIds[0], agentId: id, projectId: TEST_PROJECT, state: 'pending' } as never);
    }
  });
  return { ids, viewer: f.personIds[0] };
}

async function bothSurfaces(ids: string[], viewer: string, now: number) {
  const map = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 60) {
    const page = await scope(() => communicationAgents({ ids: ids.slice(i, i + 60).join(',') }, viewer, now));
    for (const a of page.agents) map.set(a.id, a.state);
  }
  const mcp = new Map<string, { state: string; freshness: string }>();
  let cursor: string | undefined;
  do {
    const page = await scope(() => findAgents({ ...(cursor ? { cursor } : {}) }, () => now, viewer));
    for (const a of page.agents) mcp.set(a.agentId, { state: a.state, freshness: a.contact.freshness });
    cursor = page.next ?? undefined;
  } while (cursor);
  return { map, mcp };
}

test('randomized sources: the map and MCP find_agents report the same state for every agent', async () => {
  const now = Date.now();
  const { ids, viewer } = await seedRandomSources(60, 7, now);
  const { map, mcp } = await bothSurfaces(ids, viewer, now);
  expect(map.size).toBe(ids.length);
  expect(mcp.size).toBe(ids.length);
  const mismatched = ids.filter(id => map.get(id) !== mcp.get(id)!.state);
  // One MCP row must not contradict itself (c1): states that need a fresh contact (working, idle) read as recent. Waiting
  // can come from a queued start with no contact, so it isn't checked.
  const freshnessContradictions = ids.filter(id => ['working', 'idle'].includes(map.get(id)!) && mcp.get(id)!.freshness !== 'recent').length;
  const states = [...map.values()].reduce<Record<string, number>>((all, s) => ({ ...all, [s]: (all[s] ?? 0) + 1 }), {});
  console.info(JSON.stringify({ sharedAgentState: { agents: ids.length, mismatched: mismatched.length, freshnessContradictions, states } }));
  expect(Object.keys(states).length).toBeGreaterThan(3);
  expect(states.unknown ?? 0).toBeLessThan(ids.length / 2);
  expect(freshnessContradictions).toBe(0);
  expect(mismatched).toEqual([]);
}, 120_000);

test('during a project pause both surfaces report the same pause state', async () => {
  const now = Date.now();
  const { ids, viewer } = await seedRandomSources(40, 11, now);
  await seedRuntime(TEST_PROJECT, { paused: true, revision: 3, pauseRequest: { revision: 3, requestedAt: now - 10_000 } });
  const { map, mcp } = await bothSurfaces(ids, viewer, now);
  const mismatched = ids.filter(id => map.get(id) !== mcp.get(id)!.state);
  const pauseStates = [...map.values()].filter(s => ['paused', 'pausing', 'pause_unconfirmed'].includes(s)).length;
  console.info(JSON.stringify({ sharedAgentStatePause: { agents: ids.length, mismatched: mismatched.length, pauseStates } }));
  expect(pauseStates).toBeGreaterThan(0);
  expect(mismatched).toEqual([]);
}, 120_000);

// Pure derivation edges (model-free).
const base = (over: Partial<AgentStateSources> = {}): AgentStateSources => ({ id: 'a', agent: { revokedAt: null } as never, allowed: true,
  run: { runId: 'r', endedAt: null } as never, queued: false, needsYou: false, sourceRevision: 0, ...over });
test('the C4-10 edge: presence ≈80 s old but the worker summary fresh reads as the worker phase, not offline', () => {
  const now = 1_000_000;
  const s = base({ contact: { runId: 'r', lastContactAt: now - 80_000, phase: 'idle' } as never,
    worker: { runId: 'r', phase: 'working', lastContactAt: now - 5_000, projectPauseRevision: null } as never });
  expect(deriveAgentState(s, now)).toMatchObject({ state: 'working', freshUntil: now - 5_000 + FRESH });
  // Presence alone at 91 s: offline, at the same moment, on every surface.
  expect(deriveAgentState(base({ contact: { runId: 'r', lastContactAt: now - 91_000, phase: 'idle' } as never }), now).state).toBe('offline');
});

test('clock-only transitions: the same sources give a new state later, with no write (c1, contract C6)', () => {
  const now = 1_000_000;
  const worker = { runId: 'r', phase: 'working', lastContactAt: now - 5_000, projectPauseRevision: null } as never;
  const s = base({ worker });
  expect(deriveAgentState(s, now).state).toBe('working');
  expect(deriveAgentState(s, now + 86_000).state).toBe('offline');      // freshness lapsed (90 s after the contact)
  // A worker in contact and still in its turn stays pausing while the turn finishes; out of contact it is unconfirmed.
  const pausing = base({ worker, pause: { revision: 3, requestedAt: now - 1_000 } });
  expect(deriveAgentState(pausing, now).state).toBe('pausing');
  expect(deriveAgentState(pausing, now + 29_500)).toMatchObject({ state: 'pausing', freshUntil: now - 5_000 + FRESH });
  expect(deriveAgentState(pausing, now + 86_000).state).toBe('pause_unconfirmed');
  // A worker between turns should confirm at once, so after 30 s it is unconfirmed.
  const between = base({ worker: { ...(worker as object), phase: 'waiting' } as never, pause: { revision: 3, requestedAt: now - 1_000 } });
  expect(deriveAgentState(between, now).state).toBe('pausing');
  expect(deriveAgentState(between, now + 29_500).state).toBe('pause_unconfirmed');
});

test('precedence is the same everywhere: revoked > needs you > waiting > stopped > worker end > fresh worker > fresh presence', () => {
  const now = 1_000_000, worker = { runId: 'r', phase: 'idle', lastContactAt: now - 1_000, projectPauseRevision: null } as never;
  expect(deriveAgentState(base({ allowed: false, needsYou: true, worker }), now).state).toBe('revoked');
  expect(deriveAgentState(base({ needsYou: true, queued: true, worker }), now).state).toBe('needs_you');
  expect(deriveAgentState(base({ queued: true, worker }), now).state).toBe('waiting');
  expect(deriveAgentState(base({ run: { runId: 'r', endedAt: now - 1 } as never, worker }), now).state).toBe('stopped');
  expect(deriveAgentState(base({ worker: { ...(worker as object), phase: 'completed' } as never }), now).state).toBe('completed');
  expect(deriveAgentState(base({ worker }), now).state).toBe('idle');
});

test('a fresh worker between turns is idle; only a queued start is waiting', () => {
  const now = 1_000_000, worker = { runId: 'r', phase: 'waiting', lastContactAt: now - 3_000, projectPauseRevision: null } as never;
  expect(deriveAgentState(base({ worker }), now).state).toBe('idle');
  expect(deriveAgentState(base({ queued: true, worker }), now).state).toBe('waiting');
});
