import express from 'express';
import { request as httpRequest, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { db, profiles } from '../src/firestore.js';
import { feedbackRoutes } from '../src/feedback/routes.js';
import { idTokenFor, resetEmulator } from './helpers.js';
let server: Server, base: string;
const input = () => ({ client_request_id: randomUUID(), kind: 'bug' as const, body: 'The project page loses my place.', page: 'My projects' as const, screenshot: null as null | { mime: string; base64: string } });
beforeAll(async () => { const app = express(); app.use('/api/feedback', feedbackRoutes('127.0.0.1')); server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve)); base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/feedback`; });
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
beforeEach(async () => { await resetEmulator(); for (const id of ['author', 'other', 'admin']) await profiles.doc(id).set({ name: `${id} synthetic`, email: `${id}@example.test`, removedAt: null }); vi.stubEnv('ADMIN_EMAILS', 'admin@example.test'); });
afterEach(() => vi.unstubAllEnvs());
async function call(path: string, token?: string, body?: object, profile = 'author') { return fetch(base + path, { method: body ? 'POST' : 'GET', headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json', 'x-mlswarm-profile-id': profile } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); }

test('private reads/screenshots/admin inbox require author or verified platform-admin authority, not project ownership', async () => {
  const token = await idTokenFor('author@example.test'), peer = await idTokenFor('other@example.test'), adminToken = await idTokenFor('admin@example.test');
  const body = input(); body.screenshot = { mime: 'image/png', base64: (await sharp({ create: { width: 8, height: 8, channels: 3, background: '#f1c456' } }).png().toBuffer()).toString('base64') };
  expect((await call('/reports', undefined, body)).status).toBe(401);
  expect((await call('/reports', token, body, 'other')).status).toBe(403);
  const created = await call('/reports', token, body), saved = await created.json(); expect(created.status).toBe(200); expect(created.headers.get('cache-control')).toContain('no-store');
  expect((await call(`/reports/${saved.id}`, peer)).status).toBe(404);
  expect((await call(`/reports/${saved.id}/screenshot`, peer)).status).toBe(404);
  expect((await call('/admin', peer)).status).toBe(403);
  expect((await call('/admin', token)).status).toBe(403);
  expect((await call('/admin', adminToken)).status).toBe(200);
  const picture = await call(`/reports/${saved.id}/screenshot`, token); expect(picture.status).toBe(200); expect(picture.headers.get('content-type')).toContain('image/webp'); expect(picture.headers.get('cache-control')).toContain('no-store'); expect(picture.headers.get('x-content-type-options')).toBe('nosniff');
  expect((await sharp(Buffer.from(await picture.arrayBuffer())).metadata()).exif).toBeUndefined();
  expect(await (await call(`/reports/${saved.id}`, adminToken)).json()).not.toHaveProperty('fingerprint');
  await profiles.doc('author').update({ removedAt: 100 });
  expect((await call(`/reports/${saved.id}`, token)).status).toBe(401);
  await profiles.doc('replacement').set({ name: 'Replacement', email: 'author@example.test', removedAt: null });
  expect((await call('/reports', token, input())).status).toBe(403);
  expect((await call(`/reports/${saved.id}`, token)).status).toBe(404);
});

test('loopback Host protection precedes oversized JSON parsing and authentication', async () => {
  const status = await new Promise<number>(resolve => { const req = httpRequest(`${base}/reports`, { method: 'POST', headers: { host: 'attacker.example', 'content-type': 'application/json' } }, res => { res.resume(); resolve(res.statusCode!); }); req.end('{'.repeat(150000)); }); expect(status).toBe(403);
});


test('lifecycle prompt preferences are private, account scoped, revision checked and retry safe', async () => {
  const token = await idTokenFor('author@example.test'), peer = await idTokenFor('other@example.test');
  expect((await call('/preferences')).status).toBe(401);
  expect(await (await call('/preferences', token)).json()).toEqual({ promptsEnabled: true, revision: 0 });
  const disable = { promptsEnabled: false, expected_revision: 0, client_request_id: randomUUID() };
  expect((await call('/preferences', token, disable, 'other')).status).toBe(403);
  expect((await call('/preferences', token, { ...disable, projectId: 'not-allowed' })).status).toBe(400);
  expect(await (await call('/preferences', token, disable)).json()).toEqual({ promptsEnabled: false, revision: 1 });
  expect(await (await call('/preferences', token, disable)).json()).toEqual({ promptsEnabled: false, revision: 1 });
  expect(await (await call('/preferences', peer)).json()).toEqual({ promptsEnabled: true, revision: 0 });
  expect((await call('/preferences', token, { ...disable, promptsEnabled: true })).status).toBe(409);
  const enable = { promptsEnabled: true, expected_revision: 1, client_request_id: randomUUID() };
  expect(await (await call('/preferences', token, enable)).json()).toEqual({ promptsEnabled: true, revision: 2 });
  // A late retry must never undo the newer preference.
  expect((await call('/preferences', token, disable)).status).toBe(409);
  expect(await (await call('/preferences', token)).json()).toEqual({ promptsEnabled: true, revision: 2 });
  expect((await db.collection('feedbackReports').get()).empty).toBe(true);
  expect((await db.collection('feedbackBudgets').get()).empty).toBe(true);
  await profiles.doc('author').update({ removedAt: 100 });
  expect((await call('/preferences', token)).status).toBe(401);
});
