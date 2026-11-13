import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { v2Routes } from '../src/v2/routes.js';
import { ownerRoutes } from '../src/owner/routes.js';
import { hashToken, newToken } from '../src/auth.js';
import { profiles } from '../src/firestore.js';
import { createPrivateProject } from '../src/projects/private.js';
import { TEST_PROJECT, idTokenFor, resetEmulator, scoped, seed } from './helpers.js';
import { seedProgressImage } from './progress-fixture.js';

// List tools return short rows, 20 at a time; detail: true returns full rows; the inbox and
// thread keep full bodies with the same paging (owner direction, 9 November 2026).
let at = 2_000_000_000_000, server: Server, base: string;
const clients: Client[] = [];
beforeEach(async () => {
  await resetEmulator(); at = 2_000_000_000_000;
  const app = express(); app.use('/api/owner', ownerRoutes(() => at)); app.use(express.json()); app.use('/v2', scoped(v2Routes(() => at)));
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()));
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
});
const fixture = () => seed({ profiles: [{ name: 'Alice', email: 'alice@example.test', role: 'owner' }, { name: 'Bob', email: 'bob@example.test' }],
  agents: [{ person: 0, name: 'Fox' }, { person: 1, name: 'Owl' }] });
async function connect(token: string) {
  const run = await fetch(base + '/v2/runs', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ client_run_id: randomUUID(), runner_version: 'lean-test' }) }).then(r => r.json());
  const client = new Client({ name: 'lean-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/v2/mcp'), { requestInit: { headers: { authorization: `Bearer ${token}`, 'x-pilot-run': run.run_id } } }));
  clients.push(client);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { type: string; text: string }[]).find(c => c.type === 'text')!.text;
    return { error: result.isError === true, value: result.isError ? text : JSON.parse(text) };
  };
}

test('the inbox and thread pages have 20 full messages by default, up to 100, and continue by cursor', async () => {
  const f = await fixture(), fox = await connect(f.agents[0].token), owl = await connect(f.agents[1].token);
  const body = (n: number) => `Message ${n}: ` + 'full evidence '.repeat(20);
  const first = await fox('send_message', { to: [f.agents[1].agentId], body: body(0), client_message_id: 'm0' });
  expect(first.error).toBe(false);
  const threadId = first.value.message.id;
  for (let n = 1; n < 25; n++) {
    at += 6000;
    const sent = await fox('send_message', { to: [f.agents[1].agentId], body: body(n), thread_id: threadId, client_message_id: `m${n}` });
    expect(sent.error, sent.value).toBe(false);
  }
  const inbox = await owl('read_agent_inbox');
  expect(inbox.value.items).toHaveLength(20);
  expect(JSON.stringify(inbox.value.items)).toContain(body(19).slice(-40));
  expect((await owl('read_agent_inbox', { limit: 100 })).value.items).toHaveLength(25);
  expect((await owl('read_agent_inbox', { limit: 101 })).error).toBe(true);

  const page = await owl('read_thread', { thread_id: threadId });
  expect(page.value.messages).toHaveLength(20);
  expect(page.value.messages[0].body.content).toBe(body(0));
  expect(page.value.next).toBeTruthy();
  const rest = await owl('read_thread', { thread_id: threadId, cursor: page.value.next });
  expect(rest.value.messages.map((m: { body: { content: string } }) => m.body.content)).toEqual([20, 21, 22, 23, 24].map(body));
  expect(rest.value.next).toBeNull();
  expect((await owl('read_thread', { thread_id: threadId, limit: 100 })).value.messages).toHaveLength(25);
  expect((await owl('read_thread', { thread_id: threadId, limit: 0 })).error).toBe(true);
});

test('find_agents, list_human_requests and list_project_updates return short rows unless detail is true', async () => {
  const f = await fixture(), fox = await connect(f.agents[0].token);
  const agents = await fox('find_agents');
  for (const row of agents.value.agents) expect(Object.keys(row).sort()).toEqual(['agentId', 'name', 'operatorName', 'sameOperator', 'state']);
  const full = await fox('find_agents', { detail: true });
  expect(Object.keys(full.value.agents[0])).toEqual(expect.arrayContaining(['focus', 'contact', 'lastReported']));
  expect((await fox('find_agents', { limit: 1 })).value.agents).toHaveLength(1);
  expect((await fox('find_agents', { limit: 101 })).error).toBe(true);

  const asked = await fox('request_human_help', { dedupe_key: 'access', visibility: 'private', title: 'Repository access',
    question: 'Please check the permitted access.', context: 'The license check is waiting; the reader refused access.' });
  expect(asked.error, asked.value).toBe(false);
  const requests = await fox('list_human_requests');
  expect(Object.keys(requests.value.items[0]).sort()).toEqual(['id', 'revision', 'status', 'title', 'visibility']);
  expect(JSON.stringify(requests.value)).not.toContain('license check');
  expect(JSON.stringify((await fox('list_human_requests', { detail: true })).value)).toContain('license check');

  const long = 'The park paths now load and the camera works. '.repeat(4).trim().slice(0, 140);
  const published = await fox('publish_project_update', { screenshot: await seedProgressImage('agent:' + f.agents[0].agentId), clientRequestId: 'u1', title: 'Park paths load', body: long, links: [] });
  expect(published.error, published.value).toBe(false);
  const updates = await fox('list_project_updates');
  const row = updates.value.items[0];
  expect(row).toMatchObject({ trust: 'untrusted', source: { type: 'agent', agentId: f.agents[0].agentId }, content: { author: 'Fox' } });
  expect(Object.keys(row.content).sort()).toEqual(['author', 'id', 'publishedAt', 'title']);
  expect([...row.content.title].length).toBeLessThanOrEqual(80);
  expect((await fox('list_project_updates', { detail: true })).value.items[0].content.body).toBe(long);
});

test('list_work_intents short rows carry the next step; detail: true adds the blocker and recordedRunId', async () => {
  const f = await fixture(), fox = await connect(f.agents[0].token);
  const saved = await fox('record_work_intent', { intent_id: 'deploy', client_request_id: 'w1', expected_revision: 0,
    state: 'blocked', next_step: 'Rerun the deploy check once access is granted.', blocker: 'Waiting for repository access.' });
  expect(saved.error, saved.value).toBe(false);
  const short = await fox('list_work_intents');
  expect(short.value.items).toEqual([{ id: 'deploy', state: 'blocked', nextStep: 'Rerun the deploy check once access is granted.', taskId: null, revision: 1 }]);
  const full = await fox('list_work_intents', { detail: true });
  expect(full.value.items[0]).toMatchObject({ id: 'deploy', blocker: 'Waiting for repository access.', recordedRunId: expect.any(String) });
});

// The connector sends ?limit= to the owner routes; a cursor continued with a different limit
// neither skips nor repeats rows.
async function ownerComputer(email: string) {
  const token = newToken(), requestId = randomUUID();
  const post = (path: string, body: object, auth = '') => fetch(base + '/api/owner' + path, { method: 'POST',
    headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await post('/connect', { requestId, pollingSecret: newToken(), candidateTokenHash: hashToken(token), clientName: 'Test' });
  expect((await post(`/connect/${requestId}/approve`, { approved: true }, await idTokenFor(email))).status).toBe(200);
  return async (path: string) => {
    const res = await fetch(base + '/api/owner' + path, { headers: { authorization: `Bearer ${token}` } });
    return { status: res.status, body: await res.json() };
  };
}

test('owner list routes take ?limit= from 1 to 100, and a cursor continues under a different limit', async () => {
  const f = await seed({ profiles: [{ name: 'Alice', email: 'alice@example.test', role: 'owner' }, { name: 'Bob', email: 'bob@example.test' }, { name: 'Cleo', email: 'cleo@example.test' }],
    agents: [{ person: 0, name: 'Fox' }, { person: 1, name: 'Owl' }, { person: 2, name: 'Elk' }] });
  const alice = { id: f.personIds[0], ...(await profiles.doc(f.personIds[0]).get()).data()! } as Parameters<typeof createPrivateProject>[0];
  for (const title of ['Second project', 'Third project']) {
    expect(await createPrivateProject(alice, { githubUrl: 'https://github.com/example/repo', client_request_id: randomUUID(), title, goal: 'Build' }, () => at)).toHaveProperty('id');
  }
  const fox = await connect(f.agents[0].token);
  for (let n = 0; n < 3; n++) {
    at += 6000;
    const sent = await fox('send_message', { to: [f.agents[1].agentId], body: `Thread ${n}`, client_message_id: `t${n}` });
    expect(sent.error, sent.value).toBe(false);
  }
  const get = await ownerComputer('alice@example.test');
  const lists = [
    { path: '/projects', key: 'projects', id: 'id' },
    { path: `/projects/${TEST_PROJECT}/agents`, key: 'agents', id: 'agentId' },
    { path: `/projects/${TEST_PROJECT}/conversations`, key: 'conversations', id: 'threadId' },
  ];
  for (const { path, key, id } of lists) {
    const all = await get(`${path}?limit=100`);
    expect(all.status, path).toBe(200);
    const expected = all.body[key].map((row: Record<string, string>) => row[id]);
    expect(expected.length, path).toBeGreaterThanOrEqual(3);
    expect((await get(`${path}?limit=1`)).body[key], path).toHaveLength(1);
    for (const bad of ['0', '101', 'many']) expect((await get(`${path}?limit=${bad}`)).status, `${path} limit=${bad}`).toBe(400);
    // Alternate page sizes while following the cursor.
    const seen: string[] = [];
    let cursor: string | null = null, turn = 0;
    do {
      const page = await get(`${path}?limit=${turn++ % 2 ? 2 : 1}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(page.status, path).toBe(200);
      seen.push(...page.body[key].map((row: Record<string, string>) => row[id]));
      cursor = page.body.next;
    } while (cursor && turn < 20);
    expect(seen, path).toEqual(expected);
  }
});
