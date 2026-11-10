import { randomUUID } from 'node:crypto';
import express from 'express';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { agents, inProject } from '../src/firestore.js';
import { v2Routes } from '../src/v2/routes.js';
import { viewRoutes } from '../src/view/routes.js';
import { reportAgentFocus } from '../src/projects/agent-focus.js';
import { startRun } from '../src/v2/runs.js';
import { idTokenFor, resetEmulator, scoped, seed, TEST_PROJECT } from './helpers.js';

let at = 10000, server: Server, base: string;
const clients: Client[] = [];
const scope = <T>(fn: () => T) => inProject(TEST_PROJECT, fn);
beforeEach(async () => {
  await resetEmulator(); at = 10000;
  const app = express(); app.use(express.json());
  app.use('/v2', scoped(v2Routes(() => at))); app.use('/view', scoped(viewRoutes(() => at)));
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()));
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
});
const fixture = () => seed({ profiles: [{ name: 'Alice', email: 'alice@example.test' }, { name: 'Bob', email: 'bob@example.test' }],
  agents: [{ person: 0, name: 'Fox' }, { person: 1, name: 'Owl' }] });
async function connect(token: string) {
  const run = await fetch(base + '/v2/runs', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ client_run_id: randomUUID(), runner_version: 'readability-test' }) }).then(r => r.json());
  const client = new Client({ name: 'readability-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/v2/mcp'), { requestInit: { headers: { authorization: `Bearer ${token}`, 'x-pilot-run': run.run_id } } }));
  clients.push(client);
  return { runId: run.run_id as string, async call(name: string, args = {}) {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { type: string; text: string }[]).find(c => c.type === 'text')!.text;
    return { error: result.isError === true, value: result.isError ? text : JSON.parse(text) };
  } };
}

test('message summaries survive delivery, thread history, viewer projection and duplicate sends', async () => {
  const f = await fixture(), fox = await connect(f.agents[0].token), owl = await connect(f.agents[1].token);
  const input = { to: [f.agents[1].agentId], body: 'Technical evidence '.repeat(35), summary: 'The preview works locally; sending is still off.', client_message_id: 'preview' };
  const first = await fox.call('send_message', input); expect(first.error).toBe(false);
  const duplicate = await fox.call('send_message', input); expect(duplicate.value.message).toEqual(first.value.message);
  const inbox = await owl.call('read_agent_inbox');
  expect(JSON.stringify(inbox.value)).toContain(input.summary);
  const replay = await owl.call('read_agent_inbox');
  expect(replay.value.items).toEqual(inbox.value.items);
  const acknowledged = await owl.call('read_agent_inbox', { ack: inbox.value.position });
  expect(acknowledged.error).toBe(false);
  expect(acknowledged.value.acknowledged).toBe(inbox.value.position);
  expect(acknowledged.value.items).toEqual([]);
  const thread = await owl.call('read_thread', { thread_id: first.value.message.id });
  expect(thread.value.messages[0]).toMatchObject({ summary: { trust: 'untrusted', content: input.summary }, body: { trust: 'untrusted', content: input.body } });
  const auth = { authorization: `Bearer ${await idTokenFor('alice@example.test')}` };
  const view = await fetch(base + `/view/threads/${first.value.message.id}`, { headers: auth }).then(r => r.json());
  expect(view.messages[0]).toMatchObject({ summary: input.summary, body: input.body });
  const search = await fetch(base + '/view/conversations/search?q=preview', { headers: auth }).then(r => r.json());
  expect(search.messages[0].summary).toBe(input.summary);
  for (const summary of ['', 'x'.repeat(181), 'two\nlines']) expect((await fox.call('send_message', { ...input, summary, client_message_id: 'invalid' })).error).toBe(true);
  at += 6000;
  expect((await fox.call('send_message', { ...input, summary: '🪴'.repeat(100), client_message_id: 'unicode' })).error).toBe(false);
});

test('worker and chat status share durable, own-agent state; retries preserve age and old runs cannot overwrite', async () => {
  const f = await fixture(), fox = await connect(f.agents[0].token), owl = await connect(f.agents[1].token);
  const id = f.agents[0].agentId;
  const input = { status: 'Checking invitation previews.', client_request_id: 'first' };
  const saved = await fox.call('set_agent_status', input); expect(saved.error).toBe(false);
  expect(saved.value.focus).toMatchObject({ text: { trust: 'untrusted', content: input.status }, updatedAt: 10000 });
  at += 1000;
  expect((await fox.call('set_agent_status', input)).value.replayed).toBe(true);
  expect((await fox.call('set_agent_status', { ...input, client_request_id: 'same-focus' })).value.focus.updatedAt).toBe(10000);
  expect((await fox.call('set_agent_status', { ...input, status: 'Changed retry' })).error).toBe(true);
  const self = await fox.call('get_project'); expect(self.value.you.focus.updatedAt).toBe(10000);
  const peers = await owl.call('find_agents', { detail: true }); expect(peers.value.agents.find((a: { agentId: string }) => a.agentId === id).focus.text.content).toBe(input.status);
  const newer = { status: 'Reviewing test results.', client_request_id: 'second' };
  const response = await fetch(base + '/v2/status', { method: 'POST', headers: { authorization: `Bearer ${f.agents[0].token}`, 'content-type': 'application/json' }, body: JSON.stringify({ ...newer, run_id: fox.runId, sequence: 2 }) });
  expect(response.status).toBe(200);
  // Replaying an earlier accepted observation cannot overwrite the newer focus.
  await fox.call('set_agent_status', input);
  const record = await scope(() => agents().doc(id).get()); expect(record.data()?.focus?.text).toBe(newer.status);
  expect((await scope(() => agents().doc(f.agents[1].agentId).get())).data()?.focus).toBeUndefined();
  const auth = { authorization: `Bearer ${await idTokenFor('alice@example.test')}` };
  const view = await fetch(base + `/view/agents/${id}`, { headers: auth }).then(r => r.json());
  expect(view.agent.focus).toEqual({ text: newer.status, updatedAt: at });
  expect(JSON.stringify(view.agent.focus)).not.toContain('runId');
  expect((await fetch(base + `/view/agents/${id}`)).status).toBe(401);
  await scope(() => startRun(id, { clientRunId: randomUUID(), runnerVersion: 'replacement', takeover: true }, () => at));
  await expect(scope(() => reportAgentFocus(id, fox.runId, { ...newer, client_request_id: 'stale' }, () => at))).rejects.toMatchObject({ code: 'run_superseded' });
  expect((await scope(() => agents().doc(id).get())).data()?.focus?.text).toBe(newer.status);
});
