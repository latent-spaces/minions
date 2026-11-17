import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { beforeEach, expect, test } from 'vitest';
import { inProject, profiles } from '../src/firestore.js';
import { mutateNativeTask } from '../src/projects/native-tasks.js';
import { registerTaskTools } from '../src/v2/task-tools.js';
import { resetEmulator, seed, TEST_PROJECT } from './helpers.js';

beforeEach(resetEmulator);

test('get_task can read small newest-first history pages and continue with the returned cursors', async () => {
  await inProject(TEST_PROJECT, async () => {
    const { personIds } = await seed({ profiles: [{ name: 'Owner', email: 'owner@example.test', role: 'owner' }] });
    const actor = { kind: 'person' as const, person: { id: personIds[0], ...(await profiles.doc(personIds[0]).get()).data()! } };
    let at = 1000;
    const now = () => at++;
    let { task } = await mutateNativeTask(actor, { operation: 'create', clientRequestId: randomUUID(), title: 'Review history' }, now);
    for (const body of ['first', 'second', 'third']) ({ task } = await mutateNativeTask(actor,
      { operation: 'comment', clientRequestId: randomUUID(), taskId: task.id, expectedRevision: task.revision, body }, now));
    const server = new McpServer({ name: 'task-reader', version: '1.0.0' });
    const client = new Client({ name: 'task-reader-check', version: '1.0.0' });
    registerTaskTools(server, () => actor, async read => inProject(TEST_PROJECT, async () =>
      ({ content: [{ type: 'text', text: JSON.stringify(await read()) }] })), now, false);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const read = async (arguments_: Record<string, unknown>) => {
        const result = CallToolResultSchema.parse(await client.callTool({ name: 'get_task', arguments: { task_id: task.id, ...arguments_ } }));
        const text = result.content.find(item => item.type === 'text');
        if (text?.type !== 'text') throw new Error('Expected task detail text.');
        return JSON.parse(text.text);
      };
      const first = await read({ limit: 1, activity_order: 'desc' });
      expect(first.comments).toHaveLength(1);
      expect(first.comments[0].body.content).toBe('third');
      expect(first.activity.map((event: { revision: number }) => event.revision)).toEqual([4]);
      const second = await read({ limit: 1, activity_order: 'desc', comment_cursor: first.nextCommentCursor, activity_cursor: first.nextActivityCursor });
      expect(second.comments[0].body.content).toBe('second');
      expect(second.activity.map((event: { revision: number }) => event.revision)).toEqual([3]);
      expect((await read({})).activity.map((event: { revision: number }) => event.revision)).toEqual([1, 2, 3, 4]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
