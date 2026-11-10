import express from 'express';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { inProject } from '../src/firestore.js';
import { conversationEntries } from '../src/projects/steering.js';
import { messagesV2 } from '../src/v2/records.js';
import { viewRoutes } from '../src/view/routes.js';
import { idTokenFor, resetEmulator, scoped, seed, TEST_PROJECT } from './helpers.js';

// Every open Overview tab polls the live map frame every 5 s and then reads the traffic for that frame's time.
// Viewers of one project in one process share both for a few seconds instead of each scanning the window.
let at: number, server: Server, base: string, token: string;
beforeEach(async () => {
  await resetEmulator(); at = 50_000_000;
  const app = express(); app.use(scoped(viewRoutes(() => at)));
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  await seed({ profiles: [{ name: 'Viewer', email: 'live-viewer@example.test' }] });
  token = await idTokenFor('live-viewer@example.test');
});
afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
const get = async (path: string) => { const response = await fetch(base + path, { headers: { authorization: `Bearer ${token}` } }); return { status: response.status, data: await response.json() }; };
const message = (id: string, createdAt: number) => ({ id, threadId: id, agentId: 'agent-a', agentName: 'A', kind: 'agent_message' as const,
  audience: 'direct' as const, to: ['agent-b'], createdAt, protocol: 2 as const, body: 'Shared body' });
const write = (id: string, createdAt: number) => inProject(TEST_PROJECT, async () => {
  await messagesV2().doc(id).set(message(id, createdAt));
  await conversationEntries().doc(id).set(message(id, createdAt));
});

test('viewers polling the live frame within 5 s share one scan, each with its own server time', async () => {
  await write('first', at - 2_000);
  const one = await get('/communication?range=recent');
  expect(one.status).toBe(200);
  expect(one.data).toMatchObject({ at, scanned: 1, serverTime: at, trafficMark: `${at - 2_000}:first` });
  // A message written now is in the next shared frame, not in this one.
  await write('second', at - 1_000);
  at += 4_999;
  const two = await get('/communication?range=recent');
  expect(two.data).toMatchObject({ at: one.data.at, scanned: 1, serverTime: at });
  at += 1;
  const three = await get('/communication?range=recent');
  expect(three.data).toMatchObject({ at, scanned: 2, trafficMark: `${one.data.at - 1_000}:second` });
  // The frame's mark read the first traffic page for its time, so a viewer's traffic read for that frame is that page.
  await write('backdated', three.data.at - 10);
  at += 1;
  expect((await get(`/communication/traffic?at=${three.data.at}`)).data.traffic.map((m: { id: string }) => m.id)).toEqual(['second', 'first']);
  // Replay and paged reads are never shared.
  await write('third', at - 500);
  expect((await get(`/communication?range=recent&at=${at}`)).data.scanned).toBe(4);
});

test('traffic for a past frame time is shared for 10 s; a frame time not yet past is read fresh', async () => {
  await write('first', at - 2_000);
  const frame = at - 1_000;
  const one = await get(`/communication/traffic?at=${frame}`);
  expect(one.status).toBe(200);
  expect(one.data.traffic.map((m: { id: string }) => m.id)).toEqual(['first']);
  await write('late', frame - 10);
  at += 9_999;
  const two = await get(`/communication/traffic?at=${frame}`);
  expect(two.data.traffic.map((m: { id: string }) => m.id)).toEqual(['first']);
  expect(two.data.serverTime).toBe(at);
  at += 1;
  expect((await get(`/communication/traffic?at=${frame}`)).data.traffic.map((m: { id: string }) => m.id)).toEqual(['late', 'first']);
  // A malformed cursor is still refused on every request, not cached.
  expect((await get(`/communication/traffic?at=${frame}&cursor=bad`)).status).toBe(400);
  expect((await get(`/communication/traffic?at=${frame}&cursor=bad`)).status).toBe(400);
  // The current instant can still gain messages, so it is not shared.
  await write('now', at);
  expect((await get(`/communication/traffic?at=${at}`)).data.traffic.map((m: { id: string }) => m.id)).toContain('now');
});
