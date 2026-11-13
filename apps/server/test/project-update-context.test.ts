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
import { resetEmulator, scoped, seed, seedRuntime } from './helpers.js';

import { saveProjectUpdateSettings } from '../src/projects/progress-settings.js';
import { readProjectUpdateContext } from '../src/projects/progress.js';

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

test('agents receive the owner\'s update settings and one shared reminder at the chosen pace', async () => {
  const f = await fixture();
  await seedRuntime(TEST_PROJECT, { started: true, paused: false, completedAt: undefined });
  const amber = await connect(f.agents[0].token), basil = await connect(f.agents[1].token);
  const project = (await amber('get_project')).value;
  expect(project.tasks.enabled).toBe(true);
  expect(project.projectUpdates).toMatchObject({ guide: 'get_mlswarm_guide updates-and-help',
    everyMinutes: 5, topics: ['results', 'blockers', 'decisions', 'summaries'], slides: true, maxSlides: 5, lastPublishedAt: null, due: true });
  expect(project.projectUpdates.writingGuidance).toBeTruthy();
  expect(project.projectUpdates).not.toHaveProperty('responsibility');
  const guide = readFileSync(new URL('../../../packages/agent-cli/skills/mlswarm/references/updates-and-help.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');
  for (const phrase of ['With Tasks on, base updates on task results', 'A post does not update or complete a task', 'at most 60 characters', 'at most 140 characters', 'about every `everyMinutes` minutes']) expect(guide).toContain(phrase);
  const input = { screenshot: await seedProgressImage('agent:' + f.agents[0].agentId), clientRequestId: 'first', title: 'Park paths load', body: 'Local checks passed; there is no deployed preview yet.', links: [] };
  expect((await amber('publish_project_update', input)).error).toBe(false);
  // One update covers the team: a teammate's post resets the reminder for everyone.
  at += 299_999;
  expect((await basil('get_project')).value.projectUpdates).toMatchObject({ lastPublishedAt: T, due: false });
  at += 1;
  expect((await basil('get_project')).value.projectUpdates).toMatchObject({ lastPublishedAt: T, due: true });
  const feed = await basil('list_project_updates', { source: 'authored_updates', detail: true });
  expect(feed.value.items[0].content.body).toBe(input.body);
  expect(feed.value.items[0].content.author.agent.id).toBe(f.agents[0].agentId);
  expect((await amber('publish_project_update', input)).value.replayed).toBe(true);
  await db.doc(projects.doc(TEST_PROJECT).path).update({ nativeTasks: { enabled: false, revision: 1 } });
  const withoutTasks = (await amber('get_project')).value;
  expect(withoutTasks.tasks.enabled).toBe(false);
  expect(withoutTasks.projectUpdates.due).toBe(true);
});

test('paused, not started and closed projects have no update due; other projects do not count', async () => {
  const f = await fixture(), amber = await connect(f.agents[0].token);
  for (const controls of [{ started: true, paused: true }, { started: false, paused: false }, { started: true, paused: true, completedAt: T }]) {
    await seedRuntime(TEST_PROJECT, controls);
    expect((await amber('get_project')).value.projectUpdates).toMatchObject({ lastPublishedAt: null, due: false });
  }
  await seedRuntime(TEST_PROJECT, { started: true, paused: false, completedAt: undefined });
  expect((await amber('get_project')).value.projectUpdates).toMatchObject({ due: true, yours: true });
  const other = 'b'.repeat(64);
  await db.collection(`projects/${other}/updates`).doc('u').set({ publishedAt: T });
  expect(await readProjectUpdateContext(TEST_PROJECT, true, T, f.agents[0].agentId)).toMatchObject({ lastPublishedAt: null, due: true });
  expect(await readProjectUpdateContext(other, true, T, f.agents[0].agentId)).toMatchObject({ lastPublishedAt: T, due: false, yours: false });
});

// One agent is asked for each due update, so two agents don't each leave it to the other (owner, 12 November 2026).
test('a due update is asked of one agent; another is asked after an interval without a post, and again after each post', async () => {
  const f = await fixture(), [a, b] = [f.agents[0].agentId, f.agents[1].agentId], minute = 60_000;
  const read = (agent: string, at: number) => readProjectUpdateContext(TEST_PROJECT, true, at, agent).then(value => [value.due, value.yours]);
  expect(await read(a, T)).toEqual([true, true]);
  expect(await read(b, T + minute)).toEqual([true, false]);
  expect(await read(a, T + 4 * minute)).toEqual([true, true]);
  expect(await read(b, T + 5 * minute)).toEqual([true, true]);
  expect(await read(a, T + 6 * minute)).toEqual([true, false]);
  await db.collection(`projects/${TEST_PROJECT}/updates`).doc('posted').set({ publishedAt: T + 7 * minute });
  expect(await read(a, T + 8 * minute)).toEqual([false, false]);
  expect(await read(a, T + 12 * minute)).toEqual([true, true]);
  expect(await read(b, T + 13 * minute)).toEqual([true, false]);
});

// A job's first second has nothing to show, and its last minutes are when the result exists (owner, 12 November 2026).
test('the first update is due one interval after the job starts, and one more in its last two minutes', async () => {
  const f = await fixture(), a = f.agents[0].agentId, minute = 60_000, job = { startsAt: T, endsAt: T + 12 * minute };
  const read = (at: number, times = job) => readProjectUpdateContext(TEST_PROJECT, true, at, a, times).then(value => [value.due, value.closing]);
  expect(await read(T)).toEqual([false, false]);
  expect(await read(T + 5 * minute - 1)).toEqual([false, false]);
  expect(await read(T + 5 * minute)).toEqual([true, false]);
  await db.collection(`projects/${TEST_PROJECT}/updates`).doc('before').set({ publishedAt: T - minute, title: 'An earlier job' });
  await db.collection(`projects/${TEST_PROJECT}/updates`).doc('first').set({ publishedAt: T + 6 * minute, title: 'The game can be won' });
  // The next update is told this job's headlines, so it does not repeat them.
  expect((await readProjectUpdateContext(TEST_PROJECT, true, T + 7 * minute, a, job)).postedTitles).toEqual(['The game can be won']);
  expect(await read(T + 10 * minute - 1)).toEqual([false, false]);
  expect(await read(T + 10 * minute)).toEqual([true, true]);
  await db.collection(`projects/${TEST_PROJECT}/updates`).doc('closing').set({ publishedAt: T + 11 * minute });
  expect(await read(T + 11 * minute + 30_000)).toEqual([false, false]);
  // A short job closes in its second half, never from its first second.
  const short = { startsAt: T + 20 * minute, endsAt: T + 22 * minute };
  expect(await read(T + 20 * minute, short)).toEqual([false, false]);
  expect(await read(T + 21 * minute, short)).toEqual([true, true]);
  expect(await readProjectUpdateContext(TEST_PROJECT, false, T + 21 * minute, a, short)).toMatchObject({ due: false, closing: false });
});

test('saved project instructions reach agents at their next context read and clear', async () => {
  const f = await fixture(), amber = await connect(f.agents[0].token);
  const before = (await amber('get_project')).value.projectUpdates;
  const text = 'Use Hebrew captions and emphasize participant demos.';
  await inProject(TEST_PROJECT, () => saveProjectUpdateSettings(f.personIds[0], { expectedRevision: 0, clientRequestId: 'custom', everyMinutes: 15, slides: false, additionalInstructions: text }, () => T));
  const after = (await amber('get_project')).value.projectUpdates;
  expect(after).toMatchObject({ everyMinutes: 15, slides: false, maxSlides: 1, guide: before.guide, additionalInstructions: text });
  expect(after.writingGuidance).not.toBe(before.writingGuidance);
  await inProject(TEST_PROJECT, () => saveProjectUpdateSettings(f.personIds[0], { expectedRevision: 1, clientRequestId: 'clear', additionalInstructions: '' }, () => T));
  expect((await amber('get_project')).value.projectUpdates).toMatchObject({ everyMinutes: 15, writingGuidance: after.writingGuidance, guide: before.guide, additionalInstructions: '', revision: 2 });
});
