import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { projectManagementRoutes } from '../src/projects/routes.js';
import { projectDocument, inProject } from '../src/firestore.js';
import { idTokenFor, resetEmulator, seed, TEST_PROJECT } from './helpers.js';

let server: Server, base: string;
beforeAll(async () => {
  const app = express(); app.use('/api/projects', projectManagementRoutes(() => 1000));
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as {port:number}).port}/api/projects/${TEST_PROJECT}/project-update-settings`;
});
afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));
beforeEach(resetEmulator);
async function fixture() {
  const f = await seed({ profiles: [{ name: 'Admin', email: 'admin@example.test', role: 'owner' },
    { name: 'Member', email: 'member@example.test' }, { name: 'Other', email: 'moderator@example.test' }] });
  return { ...f, admin: await idTokenFor('admin@example.test'), member: await idTokenFor('member@example.test'), moderator: await idTokenFor('moderator@example.test') };
}
async function http(token?: string, body?: object) {
  const response = await fetch(base, { method: body ? 'POST' : 'GET', headers: {
    'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}),
  }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json() };
}
test('only the project owner can configure writing style; retired fields and stale saves are refused', async () => {
  const f = await fixture(), input = { expectedRevision: 0, clientRequestId: 'first', writingStyle: 'brief' };
  expect((await http()).status).toBe(401);
  for (const token of [f.member, f.moderator]) {
    expect((await http(token)).status).toBe(403); expect((await http(token, input)).status).toBe(403);
  }
  expect((await http(f.admin)).body).toEqual({ writingStyle: 'brief', additionalInstructions: '', revision: 0, updatedAt: null });
  for (const intervalMinutes of [5, null]) expect((await http(f.admin, { ...input, intervalMinutes })).status).toBe(400);
  for (const writingStyle of [undefined, '', 'verbose', null]) expect((await http(f.admin, { ...input, writingStyle })).status).toBe(400);
  expect((await http(f.admin, { ...input, ownerProfileId: f.personIds[0] })).status).toBe(400);
  expect((await http(f.admin, input)).body).toMatchObject({ writingStyle: 'brief', additionalInstructions: '', revision: 1, replayed: false });
  expect((await http(f.admin, { ...input, clientRequestId: 'stale', writingStyle: 'detailed' })).status).toBe(409);
  const detailed = { expectedRevision: 1, clientRequestId: 'detailed', writingStyle: 'detailed' };
  expect((await http(f.admin, detailed)).body).toMatchObject({ writingStyle: 'detailed', revision: 2 });
  expect((await http(f.admin, input)).body).toMatchObject({ writingStyle: 'brief', additionalInstructions: '', revision: 1, replayed: true });
  expect((await http(f.admin)).body).toMatchObject({ writingStyle: 'detailed', revision: 2 });
  expect((await http(f.admin, { ...input, writingStyle: 'detailed' })).status).toBe(409);
});

test('existing saved style survives retired interval fields without exposing or retaining timing', async () => {
  const f = await fixture();
  const record = inProject(TEST_PROJECT, () => projectDocument('settings/projectUpdates'));
  await record.set({ intervalMinutes: null, writingStyle: 'detailed', revision: 4, updatedAt: 500, updatedByProfileId: f.personIds[0] });
  expect((await http(f.admin)).body).toEqual({ writingStyle: 'detailed', additionalInstructions: '', revision: 4, updatedAt: 500 });
  const result = await http(f.admin, { expectedRevision: 4, clientRequestId: 'style-only', writingStyle: 'brief' });
  expect(result.status).toBe(200);
  expect(result.body).toEqual({ writingStyle: 'brief', additionalInstructions: '', revision: 5, updatedAt: 1000, replayed: false });
  expect((await record.get()).data()).not.toHaveProperty('intervalMinutes');
});


test('additional instructions persist, preserve omitted values, clear explicitly, and retain exact retries', async () => {
  const f = await fixture();
  const input = { expectedRevision: 0, clientRequestId: 'instructions', writingStyle: 'brief', additionalInstructions: 'Write in Hebrew. Explain what participants can try. 🌱' };
  expect((await http(f.admin, input)).body).toMatchObject({ additionalInstructions: input.additionalInstructions, revision: 1 });
  expect((await http(f.admin)).body.additionalInstructions).toBe(input.additionalInstructions);
  expect((await http(f.admin, { ...input, additionalInstructions: 'Different' })).status).toBe(409);
  expect((await http(f.admin, { expectedRevision: 1, clientRequestId: 'style', writingStyle: 'detailed' })).body.additionalInstructions).toBe(input.additionalInstructions);
  expect((await http(f.admin, input)).body).toMatchObject({ additionalInstructions: input.additionalInstructions, replayed: true, revision: 1 });
  expect((await http(f.admin, { ...input, expectedRevision: 2, clientRequestId: 'clear', additionalInstructions: '' })).body.additionalInstructions).toBe('');
  for (const additionalInstructions of [null, 1, '🌱'.repeat(4001)])
    expect((await http(f.admin, { ...input, expectedRevision: 3, clientRequestId: 'invalid', additionalInstructions })).status).toBe(400);
  expect((await http(f.admin, { ...input, expectedRevision: 3, clientRequestId: 'boundary', additionalInstructions: '🌱'.repeat(4000) })).status).toBe(200);
});
