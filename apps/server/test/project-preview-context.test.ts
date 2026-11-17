import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { beforeEach, expect, test } from 'vitest';
import { inProject } from '../src/firestore.js';
import { serverFor } from '../src/v2/routes.js';
import { startRun } from '../src/v2/runs.js';
import { loadAgent, resetEmulator, seed, TEST_PROJECT } from './helpers.js';

beforeEach(resetEmulator);

test('agent project context follows saved, replaced and cleared Preview URLs', async () => {
  await inProject(TEST_PROJECT, async () => {
    const { agents } = await seed({ profiles: [{ name: 'Owner', email: 'owner@example.test', role: 'owner' }],
      agents: [{ person: 0, name: 'scout' }] });
    const agent = await loadAgent(agents[0].agentId), now = () => Date.now();
    const run = await startRun(agent.id, { clientRunId: randomUUID(), runnerVersion: 'test', takeover: false }, now);
    const server = serverFor(agent, run.run_id, now, () => 0, async () => ({ count: 1, observedAt: now() }));
    const client = new Client({ name: 'preview-context-check', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const call = async (name: string, args: Record<string, unknown> = {}) => {
        const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
        const text = result.content.find(item => item.type === 'text');
        if (text?.type !== 'text' || result.isError) throw new Error(text?.text ?? 'Expected tool response text.');
        return JSON.parse(text.text);
      };
      expect((await call('get_project')).project.previewUrl).toBeNull();
      for (const url of ['http://localhost:43210/checkup/', 'https://example.test/preview?v=2', '']) {
        expect((await call('set_project_preview', { url })).previewUrl).toBe(url || null);
        // The worker bridge uses this exact field when it prepares the next turn's Preview guidance.
        expect((await call('get_project')).project.previewUrl).toBe(url || null);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
});
