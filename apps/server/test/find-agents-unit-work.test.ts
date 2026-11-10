// Counted reads of one MCP find_agents page. Same counting rules as steady-state-unit-work.test.ts: a document get is
// one read, a query is max(1, results), a count is one read per 1,000 entries. Model-free, disposable emulator.
import { randomUUID } from 'node:crypto';
import { beforeEach, expect, test } from 'vitest';
import { V2_LIMITS } from '../src/config.js';
import { inProject } from '../src/firestore.js';
import { workerPointer } from '../src/projects/worker-sessions.js';
import { findAgents } from '../src/v2/agents.js';
import { presence, runs } from '../src/v2/records.js';
import { resetEmulator, seed, TEST_PROJECT } from './helpers.js';
import { FirestorePrototype, QueryPrototype, TransactionPrototype } from './store-prototypes.js';

const counted = { reads: 0 };
const readsOf = (result: unknown): number => {
  if (Array.isArray(result)) return result.length;
  const value = result as { size?: number; data?: () => { count?: unknown } };
  if (typeof value?.size === 'number') return Math.max(1, value.size);
  const count = typeof value?.data === 'function' ? value.data()?.count : undefined;
  return typeof count === 'number' ? Math.max(1, Math.ceil(count / 1000)) : 1;
};
function wrap(proto: object, name: string) {
  const original = (proto as Record<string, (...args: unknown[]) => unknown>)[name];
  Object.defineProperty(proto, name, { configurable: true, writable: true, value: function (this: unknown, ...args: unknown[]) {
    const result = original.apply(this, args);
    if (result instanceof Promise) return result.then(value => { counted.reads += readsOf(value); return value; });
    counted.reads += readsOf(result);
    return result;
  } });
}
wrap(FirestorePrototype, 'getAll');
wrap(TransactionPrototype, 'get');
wrap(TransactionPrototype, 'getAll');
wrap(QueryPrototype, 'get');
beforeEach(resetEmulator);

test('counted: one find_agents page of 20 running agents (one owner)', async () => {
  const now = Date.now();
  const f = await seed({ profiles: [{ name: 'Owner', email: 'fa-owner@example.test' }],
    agents: Array.from({ length: V2_LIMITS.findAgentsPage }, (_, i) => ({ person: 0, name: `fa-${String(i).padStart(2, '0')}` })) });
  await inProject(TEST_PROJECT, async () => {
    for (const { agentId } of f.agents) {
      const runId = randomUUID();
      await runs().doc(agentId).set({ runId, generation: 1, runnerVersion: 'p1', startedAt: now - 60_000, endedAt: null, endReason: null, protocol: 2 });
      await presence().doc(agentId).set({ runId, lastContactAt: now - 30_000, phase: 'idle', phaseAt: now - 30_000, lastTurn: null, acceptingWork: null, protocol: 2 });
      await workerPointer(agentId).set({ missionId: randomUUID(), summary: { runId, phase: 'working', lastContactAt: now - 5_000, projectPauseRevision: null } } as never);
    }
  });
  counted.reads = 0;
  const page = await inProject(TEST_PROJECT, () => findAgents({}, () => now, f.personIds[0]));
  console.info(JSON.stringify({ findAgentsUnitWork: { agents: page.agents.length, reads: counted.reads, perAgent: +(counted.reads / page.agents.length).toFixed(2) } }));
  expect(page.agents).toHaveLength(V2_LIMITS.findAgentsPage);
});
