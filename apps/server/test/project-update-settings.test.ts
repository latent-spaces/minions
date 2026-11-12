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
const DEFAULTS = { everyMinutes: 5, topics: ['results', 'blockers', 'decisions', 'summaries'], slides: true, additionalInstructions: '' };
test('only the project owner can configure updates; unknown fields, bad values and stale saves are refused', async () => {
  const f = await fixture(), input = { expectedRevision: 0, clientRequestId: 'first', everyMinutes: 15 };
  expect((await http()).status).toBe(401);
  for (const token of [f.member, f.moderator]) {
    expect((await http(token)).status).toBe(403); expect((await http(token, input)).status).toBe(403);
  }
  expect((await http(f.admin)).body).toEqual({ ...DEFAULTS, revision: 0, updatedAt: null });
  for (const everyMinutes of [0, 10, '5', null]) expect((await http(f.admin, { ...input, everyMinutes })).status).toBe(400);
  for (const topics of [[], ['results', 'results'], ['news'], 'results']) expect((await http(f.admin, { ...input, topics })).status).toBe(400);
  expect((await http(f.admin, { ...input, slides: 'yes' })).status).toBe(400);
  for (const extra of [{ writingStyle: 'brief' }, { intervalMinutes: 5 }, { ownerProfileId: f.personIds[0] }]) expect((await http(f.admin, { ...input, ...extra })).status).toBe(400);
  expect((await http(f.admin, input)).body).toMatchObject({ ...DEFAULTS, everyMinutes: 15, revision: 1, replayed: false });
  expect((await http(f.admin, { ...input, clientRequestId: 'stale', everyMinutes: 30 })).status).toBe(409);
  const next = { expectedRevision: 1, clientRequestId: 'next', topics: ['decisions', 'blockers'], slides: false };
  expect((await http(f.admin, next)).body).toMatchObject({ everyMinutes: 15, topics: ['blockers', 'decisions'], slides: false, revision: 2 });
  expect((await http(f.admin, input)).body).toMatchObject({ ...DEFAULTS, everyMinutes: 15, revision: 1, replayed: true });
  expect((await http(f.admin)).body).toMatchObject({ everyMinutes: 15, topics: ['blockers', 'decisions'], slides: false, revision: 2 });
  expect((await http(f.admin, { ...input, everyMinutes: 30 })).status).toBe(409);
});

test('a record saved with the retired writing style reads with the defaults and drops the old fields on save', async () => {
  const f = await fixture();
  const record = inProject(TEST_PROJECT, () => projectDocument('settings/projectUpdates'));
  await record.set({ intervalMinutes: null, writingStyle: 'detailed', additionalInstructions: 'Keep it calm.', revision: 4, updatedAt: 500, updatedByProfileId: f.personIds[0] });
  expect((await http(f.admin)).body).toEqual({ ...DEFAULTS, additionalInstructions: 'Keep it calm.', revision: 4, updatedAt: 500 });
  const result = await http(f.admin, { expectedRevision: 4, clientRequestId: 'pace', everyMinutes: 30 });
  expect(result.status).toBe(200);
  expect(result.body).toEqual({ ...DEFAULTS, everyMinutes: 30, additionalInstructions: 'Keep it calm.', revision: 5, updatedAt: 1000, replayed: false });
  const stored = (await record.get()).data();
  expect(stored).not.toHaveProperty('intervalMinutes'); expect(stored).not.toHaveProperty('writingStyle');
});

test('additional instructions persist, preserve omitted values, clear explicitly, and retain exact retries', async () => {
  const f = await fixture();
  const input = { expectedRevision: 0, clientRequestId: 'instructions', additionalInstructions: 'Write in Hebrew. Explain what participants can try. 🌱' };
  expect((await http(f.admin, input)).body).toMatchObject({ additionalInstructions: input.additionalInstructions, revision: 1 });
  expect((await http(f.admin)).body.additionalInstructions).toBe(input.additionalInstructions);
  expect((await http(f.admin, { ...input, additionalInstructions: 'Different' })).status).toBe(409);
  expect((await http(f.admin, { expectedRevision: 1, clientRequestId: 'pace', everyMinutes: 30 })).body.additionalInstructions).toBe(input.additionalInstructions);
  expect((await http(f.admin, input)).body).toMatchObject({ additionalInstructions: input.additionalInstructions, replayed: true, revision: 1 });
  expect((await http(f.admin, { ...input, expectedRevision: 2, clientRequestId: 'clear', additionalInstructions: '' })).body.additionalInstructions).toBe('');
  for (const additionalInstructions of [null, 1, '🌱'.repeat(1001)])
    expect((await http(f.admin, { ...input, expectedRevision: 3, clientRequestId: 'invalid', additionalInstructions })).status).toBe(400);
  expect((await http(f.admin, { ...input, expectedRevision: 3, clientRequestId: 'boundary', additionalInstructions: '🌱'.repeat(1000) })).status).toBe(200);
});
