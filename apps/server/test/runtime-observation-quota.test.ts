import express from 'express';
import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { profiles } from '../src/firestore.js';
import { ownerRoutes } from '../src/owner/routes.js';
import { createPrivateProject } from '../src/projects/private.js';
import { idTokenFor, resetEmulator, seed } from './helpers.js';

test('runtime observations keep their own per-owner budget, separate from the owner’s action budget', async () => {
  await resetEmulator();
  let at = Date.now();
  const f = await seed({ profiles: [{ name: 'Owner', email: 'review-room@example.test' }] });
  const person = { id: f.personIds[0], ...(await profiles.doc(f.personIds[0]).get()).data()! };
  const { id: projectId } = await createPrivateProject(person, { client_request_id: randomUUID(), title: 'Review room', goal: 'Synthetic quota check', githubUrl: 'https://github.com/example/repo' }, () => at) as { id: string };
  const app = express(); app.use('/api/owner', ownerRoutes(() => at));
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/owner`;
  async function call(path: string, token: string, body?: object) {
    const r = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const value = await r.json(); return { status: r.status, value };
  }
  try {
    // The connector signs in with the owner's local session (owner decision, 15 November 2026).
    const token = await idTokenFor(person.email);
    const readiness = { protocol: 1, version: '0.1.0', incarnation: randomUUID(), platform: 'darwin', github: 'ready', providers: [{ id: 'codex', available: true, reason: 'ready' }] };
    expect((await call('/runtime/readiness', token, readiness)).status).toBe(200);
    // Four normal service ticks plus repository sharing still succeed.
    for (let i = 0; i < 4; i++) {
      expect((await call('/runtime/readiness', token, readiness)).status).toBe(200);
      expect((await call('/agent-starts', token)).status).toBe(200);
    }
    expect((await call('/repository-access', token)).status).toBe(200);
    expect((await call(`/projects/${projectId}/overview`, token)).status).toBe(200);
    // Runtime traffic has a 120/minute bound per owner: one initial readiness + eight tick calls
    // + one sharing call + 110 reads. The owner's own actions keep their separate budget.
    for (let i = 0; i < 110; i++) expect((await call('/agent-starts', token)).status).toBe(200);
    expect((await call('/agent-starts', token)).status).toBe(429);
    expect((await call('/runtime/readiness', token, readiness)).status).toBe(429);
    expect((await call(`/projects/${projectId}/overview`, token)).status).toBe(200);
    at += 60_000;
    expect((await call('/runtime/readiness', token, readiness)).status).toBe(200);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
