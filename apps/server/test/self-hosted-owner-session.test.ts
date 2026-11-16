import express from 'express';
import { request } from 'node:http';
import { afterEach, expect, test, vi } from 'vitest';
import { localOwnerSession } from '../src/self-hosted-owner-session.js';

afterEach(() => { vi.unstubAllEnvs(); });
type Reply = { status: number; body: string; headers: Record<string, string | string[] | undefined> };
async function fixture(run: (f: { port: number; post(headers?: Record<string, string>): Promise<Reply>; uninstall(): void; issued(): number }) => Promise<void>) {
  vi.stubEnv('MINIONS_ENGINE', 'self-hosted');
  let origin = '', installed = true, issued = 0;
  const app = express();
  app.use('/api/auth/local-owner', localOwnerSession({ provider: { issueSession: () => `synthetic-session-${++issued}` }, origin: () => origin, installed: () => installed, now: () => 1_800_000_000_000 }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No address');
  const port = address.port; origin = `http://127.0.0.1:${port}`;
  // node:http lets a test set the Host header, which fetch does not.
  const post = (headers: Record<string, string> = {}) => new Promise<Reply>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method: 'POST', path: '/api/auth/local-owner/session',
      headers: { host: `127.0.0.1:${port}`, origin, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...headers } }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; }); res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject); req.end('{}');
  });
  try { await run({ port, post, uninstall: () => { installed = false; }, issued: () => issued }); }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}

test('the engine’s own page gets the owner session with no link or sign-in step', async () => fixture(async f => {
  const reply = await f.post();
  expect(reply.status).toBe(200);
  expect(JSON.parse(reply.body)).toEqual({ token: 'synthetic-session-1' });
  expect(reply.headers['cache-control']).toBe('no-store');
  const localhost = `http://localhost:${f.port}`;
  expect((await f.post({ host: `localhost:${f.port}`, origin: localhost })).status).toBe(200);
}));

test('other websites, rebinding hosts and non-JSON requests get no session', async () => fixture(async f => {
  for (const headers of <Record<string, string>[]>[
    { origin: 'https://example.com' },
    { origin: 'null' },
    { host: `evil.example:${f.port}`, origin: `http://evil.example:${f.port}` },
    { host: '127.0.0.1:1', origin: 'http://127.0.0.1:1' },
    { 'content-type': 'text/plain' },
    { 'sec-fetch-site': 'cross-site' },
  ]) expect((await f.post(headers)).status).toBe(403);
  expect(f.issued()).toBe(0);
}));

test('an engine without its owner provider installed answers not found', async () => fixture(async f => {
  f.uninstall();
  expect((await f.post()).status).toBe(404);
  expect(f.issued()).toBe(0);
}));
