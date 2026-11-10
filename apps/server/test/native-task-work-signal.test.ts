import { randomUUID } from 'node:crypto';
import { beforeEach, expect, test } from 'vitest';
import { db, inProject, profiles } from '../src/firestore.js';
import { mutateNativeTask } from '../src/projects/native-tasks.js';
import { saveNativeTaskSettings } from '../src/projects/native-task-settings.js';
import { startRun } from '../src/v2/runs.js';
import { recordWorkIntent } from '../src/v2/work-intents.js';
import { effectiveTaskWorkSignal, workSignalDoc } from '../src/v2/work-signals.js';
import { seed, resetEmulator, TEST_PROJECT } from './helpers.js';

beforeEach(resetEmulator);
test('OFF ignores task-derived hints, keeps ordinary work and human answers, and permits terminal checkpoint cleanup', async () => inProject(TEST_PROJECT, async () => {
  const f = await seed({ profiles: [{ name: 'Admin', email: 'admin@example.test', role: 'owner' }], agents: [{ person: 0, name: 'Otter' }] });
  const person = { id: f.personIds[0], ...(await profiles.doc(f.personIds[0]).get()).data()! };
  const { task } = await mutateNativeTask({ kind: 'person', person }, { operation: 'create', title: 'Retained work', clientRequestId: randomUUID() }, () => 1000);
  const agent = f.agents[0].agentId, run = await startRun(agent, { clientRunId: randomUUID(), runnerVersion: 'test', takeover: false }, () => 1000);
  const linked = { intent_id: 'linked', client_request_id: 'linked', expected_revision: 0, state: 'runnable', next_step: 'Pending task operation', task_id: task.id };
  await recordWorkIntent(agent, run.run_id, linked, () => 1000);
  expect((await effectiveTaskWorkSignal(agent, run.run_id, () => 1000)).runnable).toBe(true);
  await saveNativeTaskSettings(person.id, { enabled: false, expectedRevision: 0, clientRequestId: randomUUID() });
  expect((await effectiveTaskWorkSignal(agent, run.run_id, () => 1000)).runnable).toBe(false);
  expect((await workSignalDoc(agent).get()).data()?.runnableCount).toBe(1); // Projection retains durable data.
  const ordinary = { intent_id: 'ordinary', client_request_id: 'ordinary', expected_revision: 0, state: 'runnable', next_step: 'Continue approved source work' };
  await recordWorkIntent(agent, run.run_id, ordinary, () => 1000);
  expect((await effectiveTaskWorkSignal(agent, run.run_id, () => 1000)).runnable).toBe(true);
  await recordWorkIntent(agent, run.run_id, { ...ordinary, client_request_id: 'ordinary-done', expected_revision: 1, state: 'done' }, () => 1000);
  expect((await effectiveTaskWorkSignal(agent, run.run_id, () => 1000)).runnable).toBe(false);
  await expect(recordWorkIntent(agent, run.run_id, linked, () => 1000)).rejects.toMatchObject({ code: 'tasks_disabled' });
  expect((await recordWorkIntent(agent, run.run_id, { ...linked, client_request_id: 'linked-cancel', expected_revision: 1, state: 'cancelled' }, () => 1000)).intent.state).toBe('cancelled');
  await db.runTransaction(async tx => { tx.update(workSignalDoc(agent), { runnable: true, humanAnswerCount: 1 }); });
  expect((await effectiveTaskWorkSignal(agent, run.run_id, () => 1000)).runnable).toBe(true);
}));
