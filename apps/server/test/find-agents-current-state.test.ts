// Request-fresh MCP status: canonical writer output, immediate acknowledged writes, bounded paging, and no
// legacy run/pointer/session reads even when those records disagree. Historical records need no migration.
import { randomUUID } from 'node:crypto';
import { Firestore } from 'firebase-admin/firestore';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { agents, inProject } from '../src/firestore.js';
import { findAgents } from '../src/v2/agents.js';
import { reportPhase, startRun } from '../src/v2/runs.js';
import { syncWorkerSession, workerPointer } from '../src/projects/worker-sessions.js';
import { presence, runs } from '../src/v2/records.js';
import { agentGroup } from '../src/v2/agent-group.js';
import { currentStateStats, stopCurrentState } from '../src/view/current-state.js';
import { resetEmulator, seed, seedRuntime, TEST_PROJECT } from './helpers.js';
import { setCanonicalStatus } from './canonical-status-fixture.js';
import { FirestorePrototype } from './store-prototypes.js';
const scope = <T>(work: () => T) => inProject(TEST_PROJECT, work);
let now = 2_000_000;
beforeEach(async () => { stopCurrentState(); await resetEmulator(); now += 1_000_000; });
afterEach(() => { vi.restoreAllMocks(); stopCurrentState(); });
async function allPages(viewer: string, namePrefix?: string) {
  const entries: Awaited<ReturnType<typeof findAgents>>['agents'] = [];
  let cursor: string | undefined;
  do {
    const page = await scope(() => findAgents({ namePrefix, cursor }, () => now, viewer));
    entries.push(...page.agents); cursor = page.next ?? undefined;
  } while (cursor);
  return entries;
}
function forbidLegacyReads() {
  const original = FirestorePrototype.getAll;
  return vi.spyOn(FirestorePrototype, 'getAll').mockImplementation(function(this: Firestore, ...refs) {
    for (const ref of refs) if ('path' in ref) expect(ref.path).not.toMatch(/\/runs\/|\/workerSessions\//);
    return original.apply(this, refs);
  });
}

test('MCP pages canonical states across owners and a name prefix, ignoring conflicting legacy sources', async () => {
  const f = await seed({ profiles: [{ name: 'Viewer', email: 'canonical-mcp@example.test' }, { name: 'Other', email: 'canonical-other@example.test' }],
    agents: Array.from({ length: 60 }, (_, i) => ({ person: i % 2, name: `agent-${String(i).padStart(3, '0')}` })) });
  const expected = new Map<string, string>();
  await scope(async () => {
    for (const [i, row] of f.agents.entries()) {
      const id = row.agentId, agent = (await agents().doc(id).get()).data()!, runId = randomUUID();
      const ended = i % 5 === 0, contactAt = i % 4 === 0 ? now - 100_000 : now - 1_000;
      await setCanonicalStatus(id, { agent: agentGroup(agent), runId, runEndedAt: ended ? now - 1 : null,
        phase: 'turn', lastContactAt: contactAt, phaseAt: contactAt });
      expected.set(id, ended ? 'stopped' : contactAt < now - 90_000 ? 'offline' : 'working');
      await runs().doc(id).set({ runId: 'unrelated-history', endedAt: null } as never);
      await workerPointer(id).set({ missionId: randomUUID(), summary: { runId, phase: 'paused', lastContactAt: now, deadlineAt: now + 60_000 } } as never);
    }
  });
  forbidLegacyReads();
  const rows = await allPages(f.personIds[0]!);
  expect(rows).toHaveLength(60);
  for (const row of rows) {
    expect(row.state).toBe(expected.get(row.agentId));
    expect(row.sameOperator).toBe(row.operatorName === 'Viewer');
  }
  const prefix = await allPages(f.personIds[0]!, 'agent-01');
  expect(prefix.map(row => row.name)).toEqual(Array.from({ length: 10 }, (_, n) => `agent-01${n}`));
  expect(currentStateStats().listeners).toBe(0);
  expect(JSON.stringify(rows)).not.toContain('unrelated-history');
}, 60_000);

test('real start, stop and restart are visible to the very next MCP call; superseded worker writes are rejected', async () => {
  const f = await seed({ profiles: [{ name: 'Owner', email: 'canonical-write@example.test' }], agents: [{ person: 0, name: 'agent' }] });
  const id = f.agents[0]!.agentId, viewer = f.personIds[0]!;
  const run = await scope(() => startRun(id, { clientRunId: randomUUID(), runnerVersion: 'test', takeover: false }, () => now));
  await scope(() => reportPhase(id, run.run_id, { phase: 'turn' }, () => now));
  const session = { run_id: run.run_id, missionId: randomUUID(), generation: 1, startedAt: now, deadlineAt: now + 600_000,
    remainingSlots: 1, phase: 'working' };
  await scope(() => syncWorkerSession(id, session, () => now));
  forbidLegacyReads();
  expect((await allPages(viewer))[0]).toMatchObject({ state: 'working', currentRunEnded: false });
  vi.restoreAllMocks();
  await scope(() => reportPhase(id, run.run_id, { phase: 'stopping' }, () => ++now));
  forbidLegacyReads();
  expect((await allPages(viewer))[0]).toMatchObject({ state: 'stopped', currentRunEnded: true });
  vi.restoreAllMocks();
  const next = await scope(() => startRun(id, { clientRunId: randomUUID(), runnerVersion: 'test', takeover: false }, () => ++now));
  await expect(scope(() => syncWorkerSession(id, session, () => now))).rejects.toMatchObject({ code: 'run_superseded' });
  expect((await scope(() => presence().doc(id).get())).get('runId')).toBe(next.run_id);
  forbidLegacyReads();
  expect((await allPages(viewer))[0]).toMatchObject({ state: 'idle', currentRunEnded: false });
  vi.restoreAllMocks();
  await seedRuntime(TEST_PROJECT, { paused: true, revision: 3, pauseRequest: { revision: 3, requestedAt: now } });
  forbidLegacyReads();
  expect((await allPages(viewer))[0]).toMatchObject({ state: 'pausing' });
});
