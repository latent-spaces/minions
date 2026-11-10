import { randomUUID } from 'node:crypto';
import { beforeEach, expect, test } from 'vitest';
import { inProject, profiles } from '../src/firestore.js';
import { mutateNativeTask } from '../src/projects/native-tasks.js';
import { recordWorkIntent, listWorkIntents } from '../src/v2/work-intents.js';
import { startRun } from '../src/v2/runs.js';
import { workSignalDoc } from '../src/v2/work-signals.js';
import { resetEmulator, seed, seedRuntime, TEST_PROJECT } from './helpers.js';

beforeEach(resetEmulator);
test('recovery checkpoints reference native task IDs, replay once, and survive repository changes without granting responsibility', async () => inProject(TEST_PROJECT, async () => {
  const f = await seed({ profiles: [{ name: 'Admin', email: 'admin@example.test' }], agents: [{ person: 0, name: 'Otter' }] });
  const person = { id: f.personIds[0], ...(await profiles.doc(f.personIds[0]).get()).data()! };
  const { task } = await mutateNativeTask({ kind: 'person', person }, { operation: 'create', title: 'Native work', clientRequestId: randomUUID() }, () => 1000);
  const agent = f.agents[0].agentId;
  const { run_id } = await startRun(agent, { clientRunId: randomUUID(), runnerVersion: 'test', takeover: false }, () => 1000);
  const input = { intent_id: 'native-work', client_request_id: 'first', expected_revision: 0, state: 'runnable', next_step: 'Inspect source', task_id: task.id };
  const one = await recordWorkIntent(agent, run_id, input, () => 1000);
  expect(one.intent).toMatchObject({ taskId: task.id, revision: 1, state: 'runnable' });
  expect(one.intent).not.toHaveProperty('issueUrl'); expect(one.intent).not.toHaveProperty('issueNumber');
  expect(await recordWorkIntent(agent, run_id, input, () => 1000)).toMatchObject({ intent: one.intent, replayed: true });
  await seedRuntime(TEST_PROJECT, { repoUrl: 'https://github.com/example/new-repository' });
  const done = await recordWorkIntent(agent, run_id, { ...input, client_request_id: 'done', expected_revision: 1, state: 'done', next_step: 'Saved result' }, () => 1100);
  expect(done.intent.taskId).toBe(task.id);
  expect((await listWorkIntents(agent, run_id, { includeCompleted: true })).items).toHaveLength(1);
  expect((await workSignalDoc(agent).get()).data()?.runnableCount).toBe(0);
  await expect(recordWorkIntent(agent, run_id, { ...input, client_request_id: 'legacy', issue_number: 1 }, () => 1200)).rejects.toMatchObject({ code: 'bad_input' });
  await expect(recordWorkIntent(agent, run_id, { ...input, intent_id: 'missing', client_request_id: 'missing', task_id: `task_${'a'.repeat(64)}` }, () => 1200)).rejects.toMatchObject({ code: 'not_found' });
}));
