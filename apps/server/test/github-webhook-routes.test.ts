import express from 'express';
import { afterEach, expect, test, vi } from 'vitest';
import { githubRoutes } from '../src/github/routes.js';

afterEach(() => { vi.unstubAllEnvs(); });

test('a webhook for an inherited object name is not a configured project', async () => {
  vi.stubEnv('GITHUB_WEBHOOK_BINDINGS', JSON.stringify({ ['a'.repeat(64)]: { repositoryId: 1, secret: 's'.repeat(32) } }));
  const app = express();
  app.use('/integrations/github', githubRoutes(Date.now));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No address');
  try {
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const reply = await fetch(`http://127.0.0.1:${address.port}/integrations/github/${name}`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${'0'.repeat(64)}` }, body: '{}' });
      expect(reply.status).toBe(404);
      expect(await reply.json()).toEqual({ error: 'not_configured' });
    }
    // A configured project still reaches signature verification.
    const signed = await fetch(`http://127.0.0.1:${address.port}/integrations/github/${'a'.repeat(64)}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${'0'.repeat(64)}` }, body: '{}' });
    expect(signed.status).toBe(401);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
