import { beforeEach, expect, test } from 'vitest';
import { inProject } from '../src/firestore.js';
import { findAgents } from '../src/v2/agents.js';
import { encodeCursor } from '../src/cursor.js';
import { resetEmulator, seed, TEST_PROJECT } from './helpers.js';

beforeEach(resetEmulator);

test('agent discovery refuses malformed cursors before Firestore can throw an internal error', async () => inProject(TEST_PROJECT, async () => {
  for (const values of [
    ['a', 'b', 'extra'], ['a', '/'],
    [TEST_PROJECT, '', 'agent', 'id', 'extra'],
    [TEST_PROJECT, '', 'agent', '/'],
    [TEST_PROJECT, '', 'agent', ''],
    [TEST_PROJECT, '', 1, 'id'],
    [TEST_PROJECT, '', 'agent', 'id/path'],
  ]) {
    await expect(findAgents({ cursor: encodeCursor(values) }, () => 1000, 'owner'))
      .rejects.toMatchObject({ code: 'bad_input' });
  }
}));

test('agent discovery pages in name order and scopes continuation to the project and prefix', async () => inProject(TEST_PROJECT, async () => {
  const fixture = await seed({ profiles: [{ name: 'Owner', email: 'owner@example.test' }],
    agents: Array.from({ length: 21 }, (_, i) => ({ person: 0, name: `agent-${String(i).padStart(2, '0')}` })) });
  const owner = fixture.personIds[0];
  const first = await findAgents({ namePrefix: 'agent-' }, () => 1000, owner);
  expect(first.agents.map(agent => agent.name)).toEqual(Array.from({ length: 20 }, (_, i) => `agent-${String(i).padStart(2, '0')}`));
  expect(first.next).not.toBeNull();
  const last = await findAgents({ namePrefix: ' agent- ', cursor: first.next! }, () => 1000, owner);
  expect(last.agents.map(agent => agent.name)).toEqual(['agent-20']);
  expect(last.next).toBeNull();
  await expect(findAgents({ namePrefix: 'agent-1', cursor: first.next! }, () => 1000, owner))
    .rejects.toMatchObject({ code: 'bad_input' });
  await expect(findAgents({ cursor: first.next! }, () => 1000, owner))
    .rejects.toMatchObject({ code: 'bad_input' });
  await inProject('b'.repeat(64), async () => {
    await expect(findAgents({ namePrefix: 'agent-', cursor: first.next! }, () => 1000, owner))
      .rejects.toMatchObject({ code: 'bad_input' });
  });
}));
