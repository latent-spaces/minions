import express from 'express';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { profiles } from '../src/firestore.js';
import { publicProfileRoutes } from '../src/community/profile.js';
import { resetEmulator } from './helpers.js';

let server: Server, base: string;
beforeAll(async () => {
  const app = express(); app.use('/profiles', publicProfileRoutes(Date.now));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/profiles`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
});
beforeEach(resetEmulator);

test.each(['private@example.test', '', '   ', 'Hidden\u0000name', 'x'.repeat(81)])(
  'direct public lookup hides an invalid stored name: %j', async name => {
    await profiles.doc('legacy').set({ name, email: 'private@example.test', removedAt: null });
    const response = await fetch(`${base}/legacy`);
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ message: 'This profile is unavailable.' });
  },
);

test('public lookup normalizes a safe display name and projects only public fields', async () => {
  await profiles.doc('person').set({ name: '  Safe Person  ', email: 'private@example.test', removedAt: null,
    githubUsername: 'safe-person', profile: { bio: 'Public bio', linkedinProfileUrl: null }, profileRevision: 9 });
  const response = await fetch(`${base}/person`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ id: 'person', name: 'Safe Person', bio: 'Public bio',
    photo: null, githubUsername: 'safe-person', linkedinProfileUrl: null });
});

test('removed and missing profiles remain unavailable', async () => {
  await profiles.doc('removed').set({ name: 'Removed Person', email: 'removed@example.test', removedAt: 100 });
  for (const id of ['removed', 'missing']) expect((await fetch(`${base}/${id}`)).status).toBe(404);
});
