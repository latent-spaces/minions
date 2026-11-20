import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { beforeEach, expect, test } from 'vitest';
import { inProject, profiles } from '../src/firestore.js';
import { mutateDeliveryReview, setDeliveryReviewObserver } from '../src/projects/delivery-review.js';
import { mutateNativeTask } from '../src/projects/native-tasks.js';
import { registerDeliveryReviewTools } from '../src/v2/delivery-review-tools.js';
import { startRun } from '../src/v2/runs.js';
import { registerTaskTools } from '../src/v2/task-tools.js';
import { loadAgent, resetEmulator, seed, TEST_PROJECT } from './helpers.js';

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

test('refresh tool labels a saved receipt separately from current delivery evidence', async () => {
  await inProject(TEST_PROJECT, async () => {
    const { personIds: [ownerId], agents: [{ agentId }] } = await seed({
      profiles: [{ name: 'Owner', email: 'owner@example.test', role: 'owner' }], agents: [{ person: 0, name: 'Author' }],
    });
    const owner = { kind: 'person' as const, person: { id: ownerId, ...(await profiles.doc(ownerId).get()).data()! } };
    const now = () => 10_000;
    const agent = await loadAgent(agentId);
    const { run_id: runId } = await startRun(agent.id, { clientRunId: randomUUID(), runnerVersion: 'test', takeover: false }, now);
    const author = { kind: 'agent' as const, agent, runId };
    const { task } = await mutateNativeTask(owner, { operation: 'create', title: 'Delivery', clientRequestId: randomUUID() }, now);
    await mutateNativeTask(owner, { operation: 'assign', taskId: task.id, expectedRevision: task.revision, assignedAgentId: agent.id,
      clientRequestId: randomUUID() }, now);
    await mutateDeliveryReview(owner, { operation: 'configure', taskId: task.id, enabled: true, expectedGeneration: 0, clientRequestId: randomUUID() }, now);
    const submit = (expectedGeneration: number, headSha: string) => mutateDeliveryReview(author, { operation: 'submit', taskId: task.id,
      expectedGeneration, headSha, repository: 'example/game', pullRequest: 1, manifest: 'Ran the unit tests.', clientRequestId: randomUUID() }, now);
    const firstHead = 'a'.repeat(40), replacementHead = 'b'.repeat(40);
    await submit(1, firstHead);
    let observations = 0;
    setDeliveryReviewObserver(async () => {
      observations++;
      return { status: 'unavailable', observedAt: now(), actualHeadSha: firstHead, checks: [] };
    });
    const server = new McpServer({ name: 'delivery-review', version: '1.0.0' });
    const client = new Client({ name: 'delivery-review-check', version: '1.0.0' });
    registerDeliveryReviewTools(server, () => author, async action => inProject(TEST_PROJECT, async () =>
      ({ content: [{ type: 'text', text: JSON.stringify(await action()) }] })), now, true, request => request);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const { tools } = await client.listTools();
      const refreshTool = tools.find(tool => tool.name === 'refresh_delivery_review');
      expect(refreshTool?.description).toContain('historical receipt');
      expect(refreshTool?.inputSchema.properties?.client_request_id).toMatchObject({ description: expect.stringContaining('new ID') });
      const call = async (name: string, input: Record<string, unknown> = {}) => {
        const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: { task_id: task.id, ...input } }));
        const text = result.content.find(item => item.type === 'text');
        if (text?.type !== 'text') throw new Error('Expected delivery review text.');
        return JSON.parse(text.text);
      };
      const refresh = () => call('refresh_delivery_review', { generation: 2, client_request_id: 'same-refresh' });
      const first = await refresh();
      expect(first).toMatchObject({ replayed: false, event: { generation: 2, kind: 'observed' } });
      await submit(2, replacementHead);
      expect(await refresh()).toEqual({ event: first.event, replayed: true, receiptScope: 'historical',
        guidance: expect.stringMatching(/get_delivery_review.*new client_request_id/) });
      expect(await call('get_delivery_review')).toMatchObject({ current: { headSha: replacementHead }, observation: null });
      expect(observations).toBe(1);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
