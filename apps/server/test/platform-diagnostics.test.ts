import express from 'express';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import type { Server } from 'node:http';
import { collection, profiles } from '../src/firestore.js';
import { platformSettings } from '../src/platform/settings.js';
import { platformRoutes } from '../src/platform/routes.js';
import { environmentLabel, lookupPlatformUsers, readPlatformHealth, readUserConnections } from '../src/platform/diagnostics.js';
import type { CommunityActor } from '../src/community/identity.js';
import { resetEmulator } from './helpers.js';
const at = 100_000, now = () => at;
const founder: CommunityActor = { kind: 'person', operatorId: 'founder', adminAuthenticated: true, verifiedGithubSession: true };
beforeEach(async () => {
  await resetEmulator();
  await profiles.doc('founder').set({ name: 'Founder', email: 'founder@example.test', removedAt: null });
  await profiles.doc('reviewer').set({ name: 'Reviewer', email: 'reviewer@example.test', removedAt: null });
  await platformSettings.set({ revision: 0, maxContributors: null, reviewerEmails: ['reviewer@example.test'], updatedAt: null, updatedBy: null });
});
test('reviewer and ordinary accounts cannot access any diagnostics, including invalid queries', async () => {
  for (const actor of [{ ...founder, adminAuthenticated: false }, { kind: 'person', operatorId: 'reviewer', verifiedGithubSession: true } satisfies CommunityActor]) {
    await expect(readPlatformHealth(actor, now)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(lookupPlatformUsers(actor, { email: 'invalid' }, now)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(readUserConnections(actor, 'nonexistent', {}, now)).rejects.toMatchObject({ code: 'forbidden' });
  }
  await profiles.doc('founder').update({ removedAt: 1 });
  await expect(readPlatformHealth(founder, now)).rejects.toMatchObject({ code: 'unauthorized' });
});
test('health reports this replica\'s request-state bounds without identities', async () => {
  const health = await readPlatformHealth(founder, now);
  expect(health.replica.requestState).toMatchObject({ maxKeys: 20_000, maxNamespaceKeys: 5000, refusedNewKeys: expect.any(Number) });
  expect(health.replica.terminalRequestState).toMatchObject({ maxKeys: 5000, maxNamespaceKeys: 5000 });
  expect(Object.keys(health.replica.requestState).sort()).toEqual(['keys', 'largestNamespaceKeys', 'maxKeys', 'maxNamespaceKeys', 'namespaces', 'refusedNewKeys']);
  // Held project-control requests fill Cloud Run request slots (TEAM-PLAN trigger); counts only.
  expect(Object.keys(health.replica.projectControl).sort()).toEqual(['heldRequests', 'lingering', 'listenerErrors', 'listeners', 'listenersOpened']);
  expect(health.replica.projectControl.heldRequests).toEqual(expect.any(Number));
  // Request-assisted fanout checks bill at least one read each (TEAM-PLAN trigger); counts only.
  expect(Object.keys(health.replica.fanoutChecks).sort()).toEqual(['checks', 'emptyChecks', 'failedChecks', 'inFlight', 'projects']);
});
test('the health environment names the self-hosted engine or a test session', () => {
  expect(environmentLabel({ MLSWARM_ENGINE: 'self-hosted', NODE_ENV: 'production' })).toBe('self-hosted');
  expect(environmentLabel({ NODE_ENV: 'test', MLSWARM_TEST_SESSION: 'mlswarm-tests-0123456789ab' })).toBe('test');
  expect(environmentLabel({})).toBe('unconfigured');
  // An ambiguous engine setting is not claimed as self-hosted.
  expect(environmentLabel({ MLSWARM_ENGINE: 'Self-Hosted' })).toBe('unconfigured');
});
test('computer pages include ended and never-connected rows, redact credentials and isolate users', async () => {
  const records = collection('computerConnections');
  const common = { clientName: 'Codex', createdAt: 1, approvedAt: 2, revokedAt: null, expiresAt: 5, connectionExpiresAt: at + 1, profileId: 'founder', firebaseUid: 'NEVER_UID', authenticatedAt: 1, pollingSecretHash: 'NEVER_POLL', candidateTokenHash: 'NEVER_HASH', localFolder: 'NEVER_FOLDER' };
  await Promise.all([
    records.doc('a').set(common), records.doc('b').set({ ...common, approvedAt: null }),
    records.doc('c').set({ ...common, revokedAt: 3, lastUsedAt: at - 1 }), records.doc('z').set({ ...common, profileId: 'reviewer' }),
  ]);
  const first = await readUserConnections(founder, 'founder', { limit: '2' }, now);
  expect(first.computers.map(c => c.status)).toEqual(['connected', 'not_connected']); expect(first.next).toBe('b');
  const second = await readUserConnections(founder, 'founder', { limit: '2', cursor: first.next }, now);
  expect(second.computers.map(c => c.status)).toEqual(['revoked']); expect(second.next).toBeNull();
  expect(second.computers[0]).toMatchObject({ lastUsedAt: at - 1, contactStatus: 'recent' });
  await records.doc('c').update({ lastUsedAt: at });
  expect((await readUserConnections(founder, 'founder', { cursor: 'b' }, () => at + 5 * 60_000)).computers[0].contactStatus).toBe('stale');
  await records.doc('c').update({ lastUsedAt: at + 1 });
  expect((await readUserConnections(founder, 'founder', { cursor: 'b' }, now)).computers[0]).toMatchObject({ lastUsedAt: null, contactStatus: 'unknown' });
  expect(first.computers[0]).toMatchObject({ lastUsedAt: null, contactStatus: 'unknown' });
  const encoded = JSON.stringify([first, second]);
  for (const secret of ['NEVER_', 'firebaseUid', 'authenticatedAt', 'pollingSecretHash', 'candidateTokenHash', 'localFolder']) expect(encoded).not.toContain(secret);
  expect((await records.doc('a').get()).data()).toEqual(common);
  await expect(readUserConnections(founder, 'founder', { limit: 51 }, now)).rejects.toMatchObject({ code: 'bad_input' });
  await expect(readUserConnections(founder, 'absent', {}, now)).rejects.toMatchObject({ code: 'not_found' });
});
let server: Server, base: string;
beforeAll(async () => { const app = express(); app.use('/api/platform', platformRoutes(now)); server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve)); base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/platform`; });
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
test('diagnostic HTTP routes require a verified session and prevent response caching', async () => {
  for (const path of ['/analytics?from=2026-10-27&to=2026-10-28', '/health', '/users?email=founder@example.test', '/users/founder/connections', '/email-quota']) {
    const response = await fetch(base + path); expect(response.status).toBe(401); expect(response.headers.get('cache-control')).toBe('no-store');
  }
});
