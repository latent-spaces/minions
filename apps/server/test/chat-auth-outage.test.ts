import express from 'express';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';

const personFromIdToken = vi.fn();
vi.mock('../src/auth.js', async (original) => ({ ...await original<object>(), personFromIdToken }));
const { humanChatRoutes } = await import('../src/projects/chat.js');
const { Refusal } = await import('../src/errors.js');
const { resetEmulator, TEST_PROJECT } = await import('./helpers.js');

let server: Server, base: string;
beforeAll(async () => {
  const app = express(); app.use('/chat', humanChatRoutes(() => 10_000)); server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/chat/${TEST_PROJECT}`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
beforeEach(async () => { personFromIdToken.mockReset(); await resetEmulator(); });
const read = (path = '') => fetch(`${base}${path}`, { headers: { authorization: 'Bearer token' } });

test('a sign-in outage is a retryable failure, not an unavailable chat', async () => {
  for (const path of ['', '/search?q=hello', `/messages/${'0'.repeat(64)}`]) {
    personFromIdToken.mockRejectedValueOnce(Object.assign(new Error('network timeout'), { code: 'app/network-timeout' }));
    const response = await read(path);
    expect(response.status, path).toBe(500);
    expect((await response.json()).error).toBe('internal_error');
  }
});

test('a rejected sign-in still reads as a guest', async () => {
  personFromIdToken.mockRejectedValueOnce(new Refusal('unauthorized', 'Sign in again.'));
  const response = await read();
  expect(response.status).toBe(404);
  expect((await response.json()).error).toBe('not_found');
});
