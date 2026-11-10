import express from 'express';
import type { Server } from 'node:http';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { limitReached, Refusal, refusalStatus, sendRefusal } from '../src/errors.js';

let server: Server, base: string;
beforeAll(async () => {
  const app = express();
  app.get('/limit', (_req, res) => sendRefusal(res, limitReached({ scope: 'agents_per_participant', limit: 3, used: 3 }, 'You already have 3 agents.')));
  app.get('/wait', (_req, res) => sendRefusal(res, new Refusal('rate_limited', 'Wait a moment.', 7), { retry_after_seconds: 7 }));
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));

test('every router maps a refusal code to the same status', () => {
  expect(refusalStatus('limit_reached')).toBe(409);
  expect(refusalStatus('duplicate')).toBe(409);
  expect(refusalStatus('image_rejected')).toBe(422);
  expect(refusalStatus('moderation_unavailable')).toBe(503);
  expect(refusalStatus('bad_input')).toBe(400);
});

test('a refusal response carries its code, limit details, Retry-After and route fields', async () => {
  const limit = await fetch(`${base}/limit`);
  expect(limit.status).toBe(409);
  expect(await limit.json()).toEqual({ error: 'limit_reached', message: 'You already have 3 agents.',
    limit: { scope: 'agents_per_participant', limit: 3, used: 3 }, retryable: false });
  const wait = await fetch(`${base}/wait`);
  expect(wait.status).toBe(429); expect(wait.headers.get('retry-after')).toBe('7');
  expect(await wait.json()).toEqual({ error: 'rate_limited', message: 'Wait a moment.', retry_after_seconds: 7 });
});
