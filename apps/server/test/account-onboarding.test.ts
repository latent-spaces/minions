import express from 'express';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { profiles } from '../src/firestore.js';
import { communityRoutes } from '../src/community/routes.js';
import { idTokenFor, resetEmulator } from './helpers.js';

let server: Server, base: string;
beforeAll(async () => {
  const app = express(); app.use('/community', communityRoutes(() => 12345));
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/community`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
beforeEach(async () => {
  await resetEmulator();
  await profiles.doc('person').set({ name: 'Person', email: 'person@example.test', removedAt: null });
  await profiles.doc('other').set({ name: 'Other', email: 'other@example.test', removedAt: null });
});
const post = (token?: string, profileId = 'person', body: object = {}) => fetch(`${base}/my-profile/onboarding/complete`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), 'x-mlswarm-profile-id': profileId }, body: JSON.stringify(body),
});

test('retired tour completion cannot write progress and account reads preserve historical data', async () => {
  const token = await idTokenFor('person@example.test');
  await profiles.doc('person').update({ onboardingCompletedAt: 111 });
  expect((await post(token)).status).toBe(404);
  expect((await post(token, 'person', { onboardingCompleted: false })).status).toBe(404);
  const me = await fetch(`${base}/me`, { headers: { authorization: `Bearer ${token}` } });
  expect(me.status).toBe(200);
  const account = await me.json();
  expect(account.person.id).toBe('person');
  expect(account).not.toHaveProperty('onboardingCompleted');
  expect((await profiles.doc('person').get()).data()!.onboardingCompletedAt).toBe(111);
  expect((await profiles.doc('other').get()).data()).not.toHaveProperty('onboardingCompletedAt');
});
