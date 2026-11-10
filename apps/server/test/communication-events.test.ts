import express from 'express';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { collection } from '../src/firestore.js';
import { humanRequests } from '../src/projects/human-requests.js';
import { viewRoutes } from '../src/view/routes.js';
import { idTokenFor, resetEmulator, scoped, seed, TEST_PROJECT } from './helpers.js';

let server: Server, base: string, now = 1_000_000;
beforeAll(async () => {
  const app = express(); app.use(scoped(viewRoutes(() => now)));
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); });
beforeEach(async () => { await resetEmulator(); now += 1_000_000; });

async function fixture() {
  const f = await seed({ profiles: [{ name: 'Reader', email: 'reader@example.test' }, { name: 'Other', email: 'other@example.test' }] });
  return { reader: f.personIds[0], other: f.personIds[1], token: await idTokenFor('reader@example.test') };
}
async function get(path: string, token?: string) {
  const res = await fetch(base + path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: res.status, data: await res.json() };
}
const update = (id: string, at: number, title: string | null, body = 'Body') => collection(`projects/${TEST_PROJECT}/updates`).doc(id).set({
  kind: 'authored_update', id, projectId: TEST_PROJECT, title, body, links: [], screenshot: null, publishedAt: at, hasResult: false,
  author: { profile: { id: 'p1', name: 'Maya' }, agent: { id: 'a1', name: 'Builder' } } });
const question = (id: string, at: number, visibility: 'project' | 'private', assignee: string) => humanRequests.doc(id).set({
  id, projectId: TEST_PROJECT, projectTitle: 'Test game', agentId: 'a2', agentName: 'Helper', requesterProfileId: 'p2', assigneeProfileId: assignee,
  visibility, title: `Question ${id}`, question: 'Which colors?', context: '', status: 'open', revision: 1, createdAt: at, updatedAt: at, answer: null, resolution: null });

test('the stage lists updates and the questions this member may read, oldest first, up to the replay time', async () => {
  const f = await fixture();
  await update('u1', now - 1000, 'Score screen is ready');
  await update('u2', now - 10, null, 'A very first   update\nwithout a title');
  await update('future', now + 5, 'Not yet');
  await question('shared', now - 500, 'project', f.other);
  await question('mine', now - 400, 'private', f.reader);
  await question('theirs', now - 300, 'private', f.other);
  const live = await get('/communication/events', f.token);
  expect(live.status).toBe(200);
  expect(live.data.events.map((e: { id: string }) => e.id)).toEqual(['update:u1', 'question:shared', 'question:mine', 'update:u2']);
  expect(live.data.events[0]).toMatchObject({ kind: 'update', agent: { id: 'a1', name: 'Builder' }, authorName: 'Maya', title: 'Score screen is ready', status: null });
  expect(live.data.events[1]).toMatchObject({ kind: 'question', agent: { id: 'a2', name: 'Helper' }, title: 'Question shared', status: 'open' });
  expect(live.data.events[3].title).toBe('A very first update without a title');
  const replay = await get(`/communication/events?at=${now - 450}`, f.token);
  expect(replay.data.events.map((e: { id: string }) => e.id)).toEqual(['update:u1', 'question:shared']);
});
