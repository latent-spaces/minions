import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, expect, test } from 'vitest';
import { inProject, profiles } from '../src/firestore.js';
import { getNativeTask, mutateNativeTask, nativeTasks } from '../src/projects/native-tasks.js';
import type { NativeTaskMutation } from '@minions/contracts';
import { resetEmulator, seed, TEST_PROJECT } from './helpers.js';

beforeEach(resetEmulator);

test('the owner connector reads a valid task detail larger than 256 KiB without dropping sections', async () => {
  await inProject(TEST_PROJECT, async () => {
    const { personIds, agents } = await seed({ profiles: [{ name: 'Owner', email: 'owner@example.test', role: 'owner' }],
      agents: [{ person: 0, name: 'worker' }] });
    const actor = { kind: 'person' as const, person: { id: personIds[0], ...(await profiles.doc(personIds[0]).get()).data()! } };
    const mutate = (input: NativeTaskMutation extends infer M ? M extends unknown ? Omit<M, 'clientRequestId'> : never : never) =>
      mutateNativeTask(actor, { ...input, clientRequestId: randomUUID() });
    let parentId: string | undefined;
    for (let i = 0; i < 10; i++) parentId = (await mutate({ operation: 'create', title: '界'.repeat(300), ...(parentId ? { parentId } : {}) })).task.id;
    let { task } = await mutate({ operation: 'create', title: '界'.repeat(300), description: '界'.repeat(2000), parentId });
    for (let i = 0; i < 30; i++) ({ task } = await mutate({ operation: 'add_reference', taskId: task.id, expectedRevision: task.revision,
      reference: { kind: 'result', id: `ref-${i}-` + 'a'.repeat(190), url: 'https://example.test/' + 'a'.repeat(1970), label: '界'.repeat(120) } }));
    for (let i = 0; i < 100; i++) {
      const id = 'task_' + String(i).padStart(64, '0');
      await nativeTasks().doc(id).set({ ...task, id, parentId: task.id, references: [], referenceAuthors: {}, description: '', assignedAgentId: agents[0].agentId });
    }
    for (let i = 0; i < 2; i++) ({ task } = await mutate({ operation: 'comment', taskId: task.id, expectedRevision: task.revision, body: '界'.repeat(6000) }));
    const detail = await getNativeTask(actor, task.id);
    const bytes = Buffer.byteLength(JSON.stringify(detail));
    expect(bytes).toBeGreaterThan(256 * 1024);
    expect(bytes).toBeLessThan(512 * 1024);

    const home = await mkdtemp(join(tmpdir(), 'minions-owner-task-'));
    const workspace = await mkdtemp(join(tmpdir(), 'minions-task-workspace-'));
    try {
      const clientModule = new URL('../../../packages/agent-cli/src/owner-client.mjs', import.meta.url).href;
      const { createOwnerClient } = await import(clientModule);
      const client = createOwnerClient({ home, workspace, site: 'http://127.0.0.1:8787', ownerSession: async () => 'synthetic-session',
        fetchImpl: async (url: URL) => Response.json(url.pathname === '/api/owner/profile' ? { profileId: actor.person.id, name: 'Owner' } : detail) });
      expect(await client.operation('read_project_task', { project_id: TEST_PROJECT, task_id: task.id })).toEqual(detail);
    } finally {
      await Promise.all([rm(home, { recursive: true, force: true }), rm(workspace, { recursive: true, force: true })]);
    }
  });
});
