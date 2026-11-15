import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectOperations } from '../runtime/project-operations.mjs';

// The turn prompt carries the goal in the project Card, so the model's own
// get_project no longer repeats it (owner direction, 9 November 2026).
test('get_project during a turn leaves out the goal the turn prompt already has', async t => {
  const root = await mkdtemp(join(tmpdir(), 'minions-goal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ops = new ProjectOperations({ url: 'http://127.0.0.1:1', token: 't', runId: 'run-1' }, join(root, 'sends.json'));
  const identity = { projectId: 'p', agentId: 'a', profileId: 'o' };
  ops.participationSnapshot = { runId: 'run-1', identity, persona: { name: 'Fox' }, capturedAt: 1, project: { name: 'Parser', mission: 'Build a parser' } };
  const project = { project: { name: 'Parser', mission: 'Build a parser', rules: 'Be kind' }, you: { participation: { identity } } };
  ops.forward = async rpc => ({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: JSON.stringify(project) }] } });
  const reply = await ops.projectForTurn({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_project', arguments: {} } });
  const value = JSON.parse(reply.result.content[0].text);
  assert.equal(value.project.mission, undefined);
  assert.equal(value.project.rules, 'Be kind');
  assert.deepEqual(value.you.participation.persona, { name: 'Fox' });
});

// The pause update turn runs only while the project is paused; a normal turn only while it is not.
test('beginParticipationTurn checks the Pause both ways', async t => {
  const root = await mkdtemp(join(tmpdir(), 'minions-pause-turn-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ops = new ProjectOperations({ url: 'http://127.0.0.1:1', token: 't', runId: 'run-1' }, join(root, 'sends.json'));
  let paused = true;
  ops.forward = async rpc => ({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: JSON.stringify({ project: { started: true, paused, completedAt: null } }) }] } });
  await assert.rejects(ops.beginParticipationTurn(), /not currently running/);
  await assert.rejects(ops.beginParticipationTurn({ pauseUpdate: true }), /rules are incomplete/);
  paused = false;
  await assert.rejects(ops.beginParticipationTurn({ pauseUpdate: true }), /no longer paused/);
});
