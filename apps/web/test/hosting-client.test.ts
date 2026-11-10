import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SessionUser } from '../src/session-identity';
import { hostingContentHost } from '@mlswarm/contracts';
import { createHostingClient, isolatedHostingUrl } from '../src/hosting-client.js';

const project = 'a'.repeat(64), artifact = 'b'.repeat(64), profile = 'owner';
test('hosting client refuses account switches before token and after response', async t => {
  for (const phase of ['before', 'token', 'body']) {
    let uid: string | undefined = phase === 'before' ? 'other' : 'owner';
    const user = { uid: 'owner', getIdToken: async () => { if (phase === 'token') uid = 'other'; return 'synthetic-token'; } } as SessionUser;
    const mocked = t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => { uid = 'other'; return {}; } } as Response));
    await assert.rejects(createHostingClient(user, project, profile, () => uid).read(), /account changed/);
    mocked.mock.restore();
  }
});
test('hosting client preserves exact candidate identity and separate human account', async t => {
  const user = { uid: 'owner', getIdToken: async () => 'synthetic-token' } as SessionUser;
  const mocked = t.mock.method(globalThis, 'fetch', async () => Response.json({ state: 'queued' }));
  await createHostingClient(user, project, profile, () => user.uid).publish(artifact, 4, 'same-request');
  const call = mocked.mock.calls[0];
  assert.equal(call.arguments[0], `/api/project-hosting/${project}/publications`);
  assert.deepEqual(JSON.parse(String(call.arguments[1]?.body)), { candidateId: artifact, policyRevision: 4, clientRequestId: 'same-request' });
  assert.equal(new Headers(call.arguments[1]?.headers).get('X-Mlswarm-Profile-Id'), profile);
});
test('embedded URLs must use the exact project origin and immutable release path', () => {
  const valid = `https://${hostingContentHost(project, 'games.example.net')}/_releases/${artifact}/`;
  assert.equal(isolatedHostingUrl(valid, project, 'https://app.example.com'), valid);
  for (const raw of [valid.replace('https:', 'http:'), valid + '?token=private', valid.replace(valid.split('.')[0], 'https://other-project'), 'javascript:alert(1)', 'https://app.example.com/']) {
    assert.equal(isolatedHostingUrl(raw, project, 'https://app.example.com'), null);
  }
  assert.equal(isolatedHostingUrl(valid, project, new URL(valid).origin), null);
});
