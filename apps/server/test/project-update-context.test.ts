import { db, inProject } from '../src/firestore.js';
import { projects } from '../src/projects/records.js';
import { TEST_PROJECT } from './helpers.js';
import { seedProgressImage } from './progress-fixture.js';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { v2Routes } from '../src/v2/routes.js';
import { resetEmulator, scoped, seed } from './helpers.js';

import { saveProjectUpdateSettings } from '../src/projects/progress-settings.js';

const T = 2_000_000_000_000;
let at = T, server: Server, base: string;
let clients: Client[] = [];
beforeEach(async () => {
  await resetEmulator(); at = T;
  const app = createMcpExpressApp(); app.use('/v2', scoped(v2Routes(() => at)));
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v2`;
});
afterEach(async () => {
  await Promise.all(clients.map(client => client.close())); clients = [];
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
});
async function connect(token: string) {
  const response = await fetch(`${base}/runs`, { method: 'POST', headers: {
    authorization: `Bearer ${token}`, 'content-type': 'application/json',
  }, body: JSON.stringify({ client_run_id: randomUUID(), runner_version: 'checkpoint-test' }) });
  expect(response.status).toBe(200);
  const { run_id: runId } = await response.json();
  const client = new Client({ name: 'checkpoint-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}`, 'X-Pilot-Run': runId } },
  }));
  clients.push(client);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const reply = await client.callTool({ name, arguments: args });
    const text = (reply.content as { text: string }[])[0].text;
    return { error: reply.isError === true, value: reply.isError ? text : JSON.parse(text) };
  };
}
const fixture = () => seed({ profiles: [{ name: 'Dana', email: 'dana@example.test', role: 'owner' }, { name: 'Noam', email: 'noam@example.test' }],
  agents: [{ person: 0, name: 'amber' }, { person: 1, name: 'basil' }] });

test('agents receive task-aware checkpoint guidance and writing style without a timed schedule', async () => {
  const f = await fixture();
  const amber = await connect(f.agents[0].token), basil = await connect(f.agents[1].token);
  const project = (await amber('get_project')).value;
  expect(project.tasks.enabled).toBe(true);
  // The shared workflow lives in the guide's updates-and-help section, not in every get_project.
  expect(project.projectUpdates).toMatchObject({ writingStyle: 'brief', guide: 'get_mlswarm_guide updates-and-help' });
  expect(project.projectUpdates.writingGuidance).toBeTruthy();
  expect(project.projectUpdates).not.toHaveProperty('instructions');
  expect(project.projectUpdates).not.toHaveProperty('responsibility');
  expect(project.tasks).not.toHaveProperty('policy');
  expect(project.tasks).not.toHaveProperty('assignment');
  expect(project).not.toHaveProperty('humanRequests.check');
  const guide = readFileSync(new URL('../../../packages/agent-cli/skills/mlswarm/references/updates-and-help.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');
  for (const phrase of ['When get_project.tasks.enabled is true', 'Tasks is off', 'a feed post does not update or complete a task']) expect(guide).toContain(phrase);
  for (const key of ['intervalMinutes', 'targetIntervalSeconds', 'suggestedNow', 'suggestedNextUpdateAt', 'lastPublishedAt', 'enabled']) {
    expect(project.projectUpdates).not.toHaveProperty(key);
  }
  const input = { screenshot: await seedProgressImage('agent:' + f.agents[0].agentId), clientRequestId: 'first', body: 'The park paths now load. Local checks passed; there is no deployed preview. Camera controls are next.', links: [] };
  expect((await amber('publish_project_update', input)).error).toBe(false);
  at += 300_000;
  expect((await basil('get_project')).value.projectUpdates).toEqual(project.projectUpdates);
  const feed = await basil('list_project_updates', { source: 'authored_updates', detail: true });
  expect(feed.value.items[0].content.body).toBe(input.body);
  expect(feed.value.items[0].content.author.agent.id).toBe(f.agents[0].agentId);
  expect((await amber('publish_project_update', input)).value.replayed).toBe(true);
  await db.doc(projects.doc(TEST_PROJECT).path).update({ nativeTasks: { enabled: false, revision: 1 } });
  const withoutTasks = (await amber('get_project')).value;
  expect(withoutTasks.tasks.enabled).toBe(false);
  expect(withoutTasks.projectUpdates).toEqual(project.projectUpdates);
});


test('saved project instructions reach agents at their next context read and clear', async () => {
  const f = await fixture(), amber = await connect(f.agents[0].token);
  const before = (await amber('get_project')).value.projectUpdates;
  const text = 'Use Hebrew captions and emphasize participant demos.';
  await inProject(TEST_PROJECT, () => saveProjectUpdateSettings(f.personIds[0], { expectedRevision: 0, clientRequestId: 'custom', writingStyle: 'brief', additionalInstructions: text }, () => T));
  const after = (await amber('get_project')).value.projectUpdates;
  expect(after).toMatchObject({ writingStyle: before.writingStyle, writingGuidance: before.writingGuidance, guide: before.guide, additionalInstructions: text });
  await inProject(TEST_PROJECT, () => saveProjectUpdateSettings(f.personIds[0], { expectedRevision: 1, clientRequestId: 'clear', writingStyle: 'brief', additionalInstructions: '' }, () => T));
  expect((await amber('get_project')).value.projectUpdates).toMatchObject({ writingStyle: before.writingStyle, writingGuidance: before.writingGuidance, guide: before.guide, additionalInstructions: '', revision: 2 });
});
