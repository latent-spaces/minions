import { Query } from 'firebase-admin/firestore';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { inProject, profiles } from '../src/firestore.js';
import { webAgentStarts } from '../src/owner/web-agent-starts.js';
import { humanRequests } from '../src/projects/human-requests.js';
import { communicationAgents, ROWS_PER_QUERY } from '../src/view/communication-agents.js';
import { resetEmulator, seed, TEST_PROJECT } from './helpers.js';
import { QueryPrototype } from './store-prototypes.js';

const at = 5_000_000;
const scope = <T>(work: () => T) => inProject(TEST_PROJECT, work);
const start = (id: string, row: { profileId: string; agentId: string; state: string; projectId?: string }) =>
  scope(() => webAgentStarts.doc(id).set({ projectId: TEST_PROJECT, ...row } as never));
const request = (id: string, row: { agentId: string; assigneeProfileId: string; visibility?: string; status?: string }) =>
  scope(() => humanRequests.doc(id).set({ projectId: TEST_PROJECT, visibility: 'private', status: 'open', ...row } as never));
const states = async (ids: string[], viewer: string) =>
  Object.fromEntries((await scope(() => communicationAgents({ ids: ids.join(',') }, viewer, at))).agents.map(a => [a.id, a.state]));
let queries = 0;
beforeEach(async () => {
  await resetEmulator(); queries = 0;
  const get = QueryPrototype.get;
  vi.spyOn(QueryPrototype, 'get').mockImplementation(function (this: Query) { queries++; return get.call(this); });
});
afterEach(() => vi.restoreAllMocks());

async function team(alice: number, bob: number) {
  const f = await seed({ profiles: [{ name: 'Alice', email: 'alice@example.test' }, { name: 'Bob', email: 'bob@example.test' }],
    agents: [...Array.from({ length: alice }, (_, i) => ({ person: 0, name: `alice-${i}` })), ...Array.from({ length: bob }, (_, i) => ({ person: 1, name: `bob-${i}` }))] });
  // The seeded project's owner, so the owner's view of other people's agents is covered.
  await scope(() => profiles.doc('seed-owner').set({ name: 'Owner', email: 'owner@example.test', removedAt: null }));
  return { ids: f.agents.map(a => a.agentId), alice: f.personIds[0], bob: f.personIds[1] };
}

test('a screen of agents from two owners gets Waiting and Needs you from a few batched queries, with the same rules as one by one', async () => {
  const { ids, alice, bob } = await team(17, 3), a = ids.slice(0, 17), b = ids.slice(17);
  await start('s-pending', { profileId: alice, agentId: a[0], state: 'pending' });
  await start('s-accepted', { profileId: alice, agentId: a[16], state: 'accepted' }); // Alice's second start query (12 agents per query)
  await start('s-other-owner', { profileId: bob, agentId: a[1], state: 'pending' }); // not the agent's owner
  await start('s-other-project', { profileId: alice, agentId: a[2], state: 'pending', projectId: 'another-project' });
  await start('s-working', { profileId: alice, agentId: a[3], state: 'working' });
  await start('s-bob', { profileId: bob, agentId: b[2], state: 'pending' });
  await request('r-open', { agentId: a[5], assigneeProfileId: alice });
  await request('r-project', { agentId: a[15], assigneeProfileId: alice, visibility: 'project' }); // second request query (9 per query)
  await request('r-moderators', { agentId: a[6], assigneeProfileId: alice, visibility: 'moderators' });
  await request('r-answered', { agentId: a[7], assigneeProfileId: alice, status: 'answered' });
  await request('r-for-bob', { agentId: a[8], assigneeProfileId: bob });
  await request('r-owner', { agentId: b[0], assigneeProfileId: 'seed-owner' });
  await request('r-bob-agent', { agentId: b[1], assigneeProfileId: alice }); // Alice may not see Needs you on Bob's agent
  queries = 0;
  const seen = await states(ids, alice);
  expect(Object.entries(seen).filter(([, s]) => s === 'waiting').map(([id]) => id).sort()).toEqual([a[0], a[16], b[2]].sort());
  expect(Object.entries(seen).filter(([, s]) => s === 'needs_you').map(([id]) => id).sort()).toEqual([a[5], a[15]].sort());
  expect(Object.keys(seen)).toHaveLength(20);
  // Starts: Alice's 17 agents in 2 queries, Bob's 3 in 1; Needs you: Alice's 17 in 2. One by one this was 20 + 17.
  expect(queries).toBe(5);
  // The project owner may see Needs you on anyone's agent.
  expect((await states(ids, 'seed-owner'))[b[0]]).toBe('needs_you');
  expect((await states([a[5]], bob))[a[5]]).toBe('unknown');
});

test('a query that fills its row limit cannot hide another agent: unseen agents are asked one by one', async () => {
  const { ids, alice } = await team(3, 0);
  for (let i = 0; i <= ROWS_PER_QUERY; i++) await request(`a-${String(i).padStart(3, '0')}`, { agentId: ids[0], assigneeProfileId: alice });
  await request('zz-last', { agentId: ids[1], assigneeProfileId: alice });
  queries = 0;
  const seen = await states(ids, alice);
  expect([seen[ids[0]], seen[ids[1]], seen[ids[2]]]).toEqual(['needs_you', 'needs_you', 'unknown']);
  // One start query, one full request query, then only the agents it did not show.
  expect(queries).toBeGreaterThanOrEqual(3);
  expect(queries).toBeLessThanOrEqual(4);
});
