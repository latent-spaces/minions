import express from 'express';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { profiles, agents, inProject, db, collection } from '../src/firestore.js';
import { projects } from '../src/projects/records.js';
import { cardDoc } from '../src/projects/card.js';
import { projectManagementRoutes, projectRuntimeRoutes } from '../src/projects/routes.js';
import { humanChatRoutes } from '../src/projects/chat.js';
import { projectDiscoveryRoutes } from '../src/projects/discovery.js';
import { projectListings } from '../src/projects/catalog.js';
import { communitySettingsDoc } from '../src/projects/community-schema.js';
import { platformSettings } from '../src/platform/settings.js';
import { membershipDoc } from '../src/projects/access.js';
import { addAgent, idTokenFor, resetEmulator, setTestMembership } from './helpers.js';
import { presence } from '../src/v2/records.js';
import { agentGroup } from '../src/v2/agent-group.js';
import { readProgressUpdates, publishProgressUpdate } from '../src/projects/progress.js';
import { readProgressScreenshot } from '../src/projects/progress-media.js';
import { seedProgressImage } from './progress-fixture.js';
import { TEST_PROJECT } from './helpers.js';

let server: Server, base: string;
const tokenProfiles = new Map<string, string>();
beforeAll(async () => {
  const app = express();
  app.use('/api/projects', projectManagementRoutes(Date.now)); app.use('/api/project-chat', humanChatRoutes(Date.now));
  app.use('/api/discovery/projects', projectDiscoveryRoutes(Date.now)); app.use('/p/:projectId', projectRuntimeRoutes(Date.now));
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
beforeEach(resetEmulator);
async function call(path: string, token?: string, body?: object, profileId = token ? tokenProfiles.get(token) : undefined) {
  const res = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(profileId ? { 'X-Minions-Profile-Id': profileId } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, data: await res.json() };
}
async function fixture(limit = 10) {
  const tokens: Record<string, string> = {};
  for (const id of ['owner', 'member', 'other']) {
    await profiles.doc(id).set({ name: id, email: `${id}@example.test`, removedAt: null }); tokens[id] = await idTokenFor(`${id}@example.test`); tokenProfiles.set(tokens[id], id);
  }
  await platformSettings.set({ revision: 1, maxContributors: null, maxPrivateParticipants: limit, reviewerEmails: [], updatedAt: 1, updatedBy: null });
  const body = { githubUrl: 'https://github.com/example/repo', client_request_id: randomUUID(), title: 'Private research', goal: 'Work together privately.' };
  const created = await call('/api/projects/private', tokens.owner, body);
  expect(created.status).toBe(200);
  return { tokens, id: created.data.id as string, body };
}
const join = (id: string, profileId: string) => setTestMembership(id, profileId, 'active', Date.now());

test('private projects reject public publication and stale public projections cannot leak their card or chat', async () => {
  const { tokens, id } = await fixture();
  expect((await call(`/api/projects/${id}/finalize`, tokens.owner, { client_request_id: randomUUID(), expected_revision: 0 })).status).toBe(403);
  expect((await call(`/api/projects/${id}/catalog`, tokens.owner, { client_request_id: randomUUID(), expected_revision: 0, listed: true, summary: 'Secret', category: 'research', tags: [] })).status).toBe(403);
  await projectListings.doc(id).set({ workspaceId: 'minions', title: 'Leaked', summary: 'Secret', category: 'research', tags: [], ownerName: 'owner', revision: 1, publishedAt: 1, updatedAt: 1, prefixes: [] });
  await communitySettingsDoc(id).update({ chatRead: 'public' });
  expect((await call(`/api/projects/${id}`, tokens.owner)).data.listed).toBe(false);
  expect((await call('/api/discovery/projects')).data.projects).toEqual([]);
  expect((await call(`/api/discovery/projects/${id}`)).status).toBe(404);
  expect((await call(`/api/projects/public/${id}/overview`, tokens.other)).status).toBe(404);
  expect((await call(`/api/projects/${id}/join`, tokens.other, { client_request_id: randomUUID() })).status).toBe(404);
  expect((await call(`/api/project-chat/${id}`)).status).toBe(404);
  expect((await call(`/api/project-chat/${id}`, tokens.other)).status).toBe(404);
});

test('leaving fences existing agent credentials and rejoining never reactivates them', async () => {
  const { tokens, id } = await fixture(); await join(id, 'member');
  const binding = await inProject(id, () => addAgent('member', 'local-reader', Date.now));
  expect((await call(`/api/projects/${id}/leave`, tokens.member, { client_request_id: randomUUID() })).status).toBe(200);
  expect((await inProject(id, () => agents().doc(binding.agentId).get())).data()?.revokedAt).not.toBeNull();
  // Member cleanup writes the status document's agent group (A1) whole, equal to the revoked agent document.
  const revoked = (await inProject(id, () => agents().doc(binding.agentId).get())).data()!;
  expect((await inProject(id, () => presence().doc(binding.agentId).get())).data()).toEqual({ agent: agentGroup(revoked), runId: null, runEndedAt: null, phase: 'stopping', phaseAt: revoked.revokedAt });
  // A deferred cleanup must not be the only thing preventing old credentials
  // from regaining access. Keep the old agent unrevoked to exercise the epoch.
  await inProject(id, () => agents().doc(binding.agentId).update({ revokedAt: null }));
  expect((await call(`/p/${id}/v2/runs`, binding.token, { client_run_id: randomUUID(), runner_version: 'test' })).status).toBe(401);
  await join(id, 'member');
  expect((await call(`/p/${id}/v2/runs`, binding.token, { client_run_id: randomUUID(), runner_version: 'test' })).status).toBe(401);
  expect((await call(`/api/projects/${id}/leave`, tokens.owner, { client_request_id: randomUUID() })).status).toBe(403);
});

test('private creation requires an existing Minions account bound to the signed-in profile', async () => {
  const { tokens } = await fixture();
  const uninvited = await idTokenFor('uninvited@example.test');
  expect((await call('/api/projects/private', uninvited, { githubUrl: 'https://github.com/example/repo', client_request_id: randomUUID(), title: 'Unauthorized', goal: 'No access' })).status).toBe(401);
  // The Google account can survive removal and a new profile; its older draft must
  // not silently execute under the newly admitted profile.
  await profiles.doc('owner').update({ removedAt: Date.now() });
  await profiles.doc('new-owner').set({ name: 'New Owner', email: 'owner@example.test', removedAt: null });
  expect((await call('/api/projects/private', tokens.owner, { githubUrl: 'https://github.com/example/repo', client_request_id: randomUUID(), title: 'Old draft', goal: 'Must not run as another profile' })).status).toBe(401);
});

async function conversionInput(id: string, token: string) {
  const preview = await call(`/api/projects/${id}/public-conversion`, token);
  expect(preview.status).toBe(200);
  return { client_request_id: randomUUID(), expected_revision: preview.data.revision, expected_card_version: preview.data.cardVersion,
    expected_listing_revision: preview.data.listingRevision, expected_community_revision: preview.data.communityRevision,
    confirm_public_chat: true, confirm_public_joining: true,
    summary: 'A public game made together.', category: 'games', tags: ['browser'] };
}

test('owner conversion discloses existing human chat atomically, retaining direct provenance and execution', async () => {
  const f = await fixture();
  const message = await call(`/api/project-chat/${f.id}`, f.tokens.owner, { client_request_id: randomUUID(), body: 'Existing private human chat selected for publication.' });
  expect(message.status).toBe(200);
  const before = (await projects.doc(f.id).get()).data()!;
  const input = await conversionInput(f.id, f.tokens.owner);
  expect((await call(`/api/projects/${f.id}/public-conversion`, f.tokens.other)).status).toBe(403);
  expect((await call(`/api/projects/${f.id}/public-conversion`, f.tokens.other, input)).status).toBe(403);
  expect((await call(`/api/project-chat/${f.id}`)).status).toBe(404);
  const result = await call(`/api/projects/${f.id}/public-conversion`, f.tokens.owner, input);
  expect(result.status).toBe(200);
  const after = (await projects.doc(f.id).get()).data()!;
  expect(after.approval).toBeNull();
  expect(after.privacy).toMatchObject({ visibility: 'public', createdAt: before.privacy!.createdAt, convertedByProfileId: 'owner', disclosure: 'card_output_human_chat_v1' });
  expect(after.execution).toEqual(before.execution);
  expect(after.setup).toEqual(before.setup);
  expect((await db.doc(`projects/${f.id}/approval/original`).get()).exists).toBe(false);
  expect((await projectListings.doc(f.id).get()).exists).toBe(true);
  expect((await call(`/api/discovery/projects/${f.id}`)).status).toBe(200);
  const chat = await call(`/api/project-chat/${f.id}`);
  expect(chat.status).toBe(200); expect(JSON.stringify(chat.data)).toContain('Existing private human chat selected for publication.');
  const replay = await call(`/api/projects/${f.id}/public-conversion`, f.tokens.owner, input);
  expect(replay.status).toBe(200); expect(replay.data.replayed).toBe(true);
  expect((await projects.doc(f.id).get()).data()!.revision).toBe(after.revision);
  expect((await call(`/api/projects/${f.id}/public-conversion`, f.tokens.owner, { ...input, summary: 'Changed decision' })).status).toBe(409);
});

test('conversion refuses missing disclosure consent, stale project/chat decisions and removed owners', async () => {
  const f = await fixture(), input = await conversionInput(f.id, f.tokens.owner);
  for (const field of ['confirm_public_chat', 'confirm_public_joining']) {
    expect((await call(`/api/projects/${f.id}/public-conversion`, f.tokens.owner, { ...input, [field]: false })).status).toBe(400);
  }
  expect((await call(`/api/projects/${f.id}/public-conversion`, f.tokens.owner, { ...input, expected_revision: input.expected_revision + 1 })).status).toBe(409);
  await communitySettingsDoc(f.id).update({ revision: input.expected_community_revision + 1 });
  expect((await call(`/api/projects/${f.id}/public-conversion`, f.tokens.owner, input)).status).toBe(409);
  expect((await projects.doc(f.id).get()).data()!.privacy!.visibility).toBe('private');
  expect((await projectListings.doc(f.id).get()).exists).toBe(false);
  await profiles.doc('owner').update({ removedAt: Date.now() });
  expect((await call(`/api/projects/${f.id}/public-conversion`, f.tokens.owner, input)).status).toBe(401);
});

test('conversion preserves existing members and uses normal public joining', async () => {
  const f = await fixture();
  await join(f.id, 'member');
  const before = (await membershipDoc(f.id, 'member').get()).data();
  const input = await conversionInput(f.id, f.tokens.owner);
  expect((await call(`/api/projects/${f.id}/public-conversion`, f.tokens.member, input)).status).toBe(403);
  expect((await call(`/api/projects/${f.id}/public-conversion`, f.tokens.owner, input)).status).toBe(200);
  expect((await membershipDoc(f.id, 'member').get()).data()).toEqual(before);
  expect((await call(`/api/projects/${f.id}/join`, f.tokens.other, { client_request_id: randomUUID() })).status).toBe(200);
  expect((await membershipDoc(f.id, 'other').get()).data()).toMatchObject({ status: 'active', role: 'member' });
});

test('converted projects refuse every public agent conversation, message, thread and search route', async () => {
  const f = await fixture(), input = await conversionInput(f.id, f.tokens.owner);
  expect((await call(`/api/projects/${f.id}/public-conversion`, f.tokens.owner, input)).status).toBe(200);
  expect((await call(`/api/projects/public/${f.id}`, f.tokens.other)).status).toBe(200);
  for (const key of ['old-thread', 'old-message']) await db.doc(`projects/${f.id}/messages/${key}`).create({ id: key, threadId: 'old-thread', agentId: 'private-agent', agentName: 'Private agent', body: 'Private transcript', createdAt: 10, to: ['project'], audience: 'project' });
  for (const path of ['conversations', 'conversations/search?q=private', 'threads/old-thread', 'threads/old-thread/search?q=private', 'messages/old-message', 'Conversations', 'Conversations/Search?q=private', 'Threads/old-thread', 'Threads/old-thread/Search?q=private', 'Messages/old-message']) {
    const result = await call(`/api/projects/public/${f.id}/${path}`, f.tokens.other);
    expect(result.status, path).toBe(404);
    expect(result.data.error, path).toBe('not_found');
  }
});

test('conversion keeps old progress and direct media private; new explicit updates carry disclosure provenance', async () => {
  const f = await fixture(), person = { id: 'owner', ...(await profiles.doc('owner').get()).data()! };
  const actor = { kind: 'person' as const, person };
  async function post(body: string) {
    const screenshot = await seedProgressImage('person:owner');
    const original = db.doc(`projects/${TEST_PROJECT}/progressUploads/${screenshot.uploadId}`);
    await db.doc(`projects/${f.id}/progressUploads/${screenshot.uploadId}`).create({ ...(await original.get()).data(), projectId: f.id });
    return publishProgressUpdate(f.id, actor, { clientRequestId: randomUUID(), title: 'Progress', body, links: [], screenshot }, Date.now);
  }
  const old = await post('Old private progress');
  const input = await conversionInput(f.id, f.tokens.owner);
  expect((await call(`/api/projects/${f.id}/public-conversion`, f.tokens.owner, input)).status).toBe(200);
  const fresh = await post('New public progress');
  const publicPage = await readProgressUpdates(f.id, null, {}, Date.now);
  expect(publicPage.items.map(item => item.id)).toEqual([fresh.update.id]);
  expect(JSON.stringify(publicPage)).not.toContain('Old private progress');
  expect(JSON.stringify(publicPage)).not.toContain('publicConversionAt');
  const memberPage = await readProgressUpdates(f.id, actor, {}, Date.now);
  expect(memberPage.items.map(item => item.id)).toContain(old.update.id);
  await expect(readProgressScreenshot(f.id, null, old.update.screenshot!.id)).rejects.toMatchObject({ code: 'not_found' });
  const stored = await collection(`projects/${f.id}/updates`).doc(fresh.update.id).get();
  const record = (await projects.doc(f.id).get()).data()!;
  expect(stored.get('publicConversionAt')).toBe(record.privacy?.visibility === 'public' ? record.privacy.convertedAt : -1);
});

test('a Card edit after disclosure preview cannot be published by the stale decision', async () => {
  const f = await fixture(), input = await conversionInput(f.id, f.tokens.owner);
  const before = (await cardDoc(f.id).get()).data()!;
  const edited = await call(`/api/projects/${f.id}/card`, f.tokens.owner, { client_request_id: randomUUID(), expected_version: before.version,
    definition: { ...before.definition, title: 'Changed private title', goal: 'New private description' } });
  expect(edited.status).toBe(200);
  expect((await projects.doc(f.id).get()).data()!.revision).toBe(input.expected_revision);
  expect((await call(`/api/projects/${f.id}/public-conversion`, f.tokens.owner, input)).status).toBe(409);
  expect((await projectListings.doc(f.id).get()).exists).toBe(false);
  const fresh = await conversionInput(f.id, f.tokens.owner);
  expect(fresh.expected_card_version).toBe(before.version + 1);
  expect((await call(`/api/projects/${f.id}/public-conversion`, f.tokens.owner, fresh)).status).toBe(200);
  expect((await projectListings.doc(f.id).get()).get('title')).toBe('Changed private title');
});

test('conversion preserves an already accepted departure receipt and durable self-cleanup', async () => {
  const f = await fixture();
  await join(f.id, 'member');
  const departure = { client_request_id: randomUUID() };
  expect((await call(`/api/projects/${f.id}/leave`, f.tokens.member, departure)).status).toBe(200);
  const job = db.doc(`projects/${f.id}/membershipCleanup/member`);
  // Simulate interruption before the final durable page is acknowledged.
  await job.update({ status: 'pending', cursor: '' });
  const input = await conversionInput(f.id, f.tokens.owner);
  expect((await call(`/api/projects/${f.id}/public-conversion`, f.tokens.owner, input)).status).toBe(200);
  const before = (await membershipDoc(f.id, 'member').get()).data();
  const replay = await call(`/api/projects/${f.id}/leave`, f.tokens.member, departure);
  expect(replay.status).toBe(200); expect(replay.data.replayed).toBe(true);
  expect((await job.get()).get('status')).toBe('done');
  expect((await membershipDoc(f.id, 'member').get()).data()).toEqual(before);
  expect((await call(`/api/projects/${f.id}/leave`, f.tokens.member, { client_request_id: randomUUID() })).status).toBe(403);
});
