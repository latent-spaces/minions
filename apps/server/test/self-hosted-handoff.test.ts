import express from 'express';
import { afterEach, expect, test, vi } from 'vitest';
import { localOwnerHandoff } from '../src/self-hosted-handoff.js';

afterEach(() => { vi.unstubAllEnvs(); });
async function fixture(run: (f: { post(path: string, body: unknown, headers?: Record<string, string>): Promise<Response>; create(): { url: string; expiresAt: number }; advance(): void; uninstall(): void; issued(): number }) => Promise<void>) {
  vi.stubEnv('MLSWARM_ENGINE', 'self-hosted');
  let origin = '', now = 1_800_000_000_000, installed = true, issued = 0;
  const handoff = localOwnerHandoff({ provider: { issueSession: () => `synthetic-session-${++issued}`, verifySession: async token => token === 'operator-session' ? {} : null },
    origin: () => origin, installed: () => installed, now: () => now });
  const app = express(); app.use('/api/auth/local-owner', handoff.router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No address');
  origin = `http://127.0.0.1:${address.port}`;
  try { await run({ post: (path, body, headers = {}) => fetch(`${origin}/api/auth/local-owner/${path}`, { method: 'POST', headers: { origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }),
    create: handoff.create, advance: () => { now += 300_000; }, uninstall: () => { installed = false; }, issued: () => issued }); }
  finally { handoff.clear(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
const code = (link: { url: string }) => new URLSearchParams(new URL(link.url).hash.slice(1)).get('mlswarm_owner_code')!;
const state = 's'.repeat(43);

test('one code binds one state, recovers a lost response with the same token, and expires', async () => fixture(async f => {
  const link = f.create(); expect(code(link)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const body = { code: code(link), client_state: state };
  const first = await f.post('exchange', body); expect(first.status).toBe(200);
  const result = await first.json(); expect(result).toEqual({ token: 'synthetic-session-1', client_state: state });
  expect(first.headers.get('cache-control')).toBe('no-store');
  expect(await (await f.post('exchange', body)).json()).toEqual(result);
  expect((await f.post('exchange', { ...body, client_state: 'x'.repeat(43) })).status).toBe(401);
  expect(f.issued()).toBe(1);
  f.advance(); expect((await f.post('exchange', body)).status).toBe(401);
}));

test('new code supersedes the old code; only a current owner can request it', async () => fixture(async f => {
  const old = f.create();
  expect((await f.post('handoff', {})).status).toBe(401);
  const response = await f.post('handoff', {}, { authorization: 'Bearer operator-session' });
  expect(response.status).toBe(200); const next = await response.json();
  expect((await f.post('exchange', { code: code(old), client_state: state })).status).toBe(401);
  expect((await f.post('exchange', { code: code(next), client_state: state })).status).toBe(200);
}));

test('cross-origin, credentialed exchange, malformed body, and disabled provider refuse without issuing a token', async () => fixture(async f => {
  const body = { code: code(f.create()), client_state: state };
  expect((await f.post('exchange', body, { origin: 'http://evil.example' })).status).toBe(403);
  expect((await f.post('exchange', body, { authorization: 'Bearer operator-session' })).status).toBe(400);
  expect((await f.post('exchange', { ...body, client_state: 'short' })).status).toBe(400);
  expect((await f.post('exchange', { ...body, token: 'unexpected' })).status).toBe(400);
  f.uninstall(); expect((await f.post('exchange', body)).status).toBe(404);
  expect(f.issued()).toBe(0);
}));

test('exchange guesses are rate limited without consuming the valid code', async () => fixture(async f => {
  const correct = code(f.create());
  for (let i = 0; i < 30; i++) expect((await f.post('exchange', { code: 'x'.repeat(43), client_state: state })).status).toBe(401);
  expect((await f.post('exchange', { code: correct, client_state: state })).status).toBe(429);
  expect(f.issued()).toBe(0);
}));
