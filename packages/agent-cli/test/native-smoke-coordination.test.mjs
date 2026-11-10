import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeSmokeCoordination } from '../scripts/native-smoke-coordination.mjs';

test('local smoke coordination preserves immutable steering and isolates projects, agents and generations', async () => {
  const ports = nativeSmokeCoordination({ ownerId: 'synthetic-owner' }, () => 123);
  const input = { operationId: 'op', agentId: 'claude', missionId: 'mission', generation: 1, body: 'Synthetic steering', origin: 'coding_chat' };
  const first = await ports.accountClient.submitSteering('project', input);
  assert.equal(first.created, true); assert.equal(first.message.createdAt, 123);
  assert.equal((await ports.accountClient.submitSteering('project', input)).created, false);
  await assert.rejects(ports.accountClient.submitSteering('project', { ...input, body: 'Changed' }), /immutable/);
  const mission = { missionId: 'mission', generation: 1, target: { projectId: 'project', agentId: 'claude' } };
  const cloud = await ports.cloudFactory(mission);
  assert.deepEqual(await cloud.start(), { runId: 'mission', cloudGeneration: 1 });
  assert.equal((await cloud.workerSession()).messages[0].body, input.body);
  for (const changed of [{ ...mission, generation: 2 }, { ...mission, target: { ...mission.target, projectId: 'other' } }, { ...mission, target: { ...mission.target, agentId: 'codex' } }]) assert.deepEqual((await (await ports.cloudFactory(changed)).workerSession()).messages, []);
  assert.equal((await ports.accountClient.steeringResult('other', 'op')).message, null);
});
