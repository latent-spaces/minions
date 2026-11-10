import express from 'express';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Server } from 'node:http';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { githubAccounts, profiles } from '../src/firestore.js';
import { communityRoutes } from '../src/community/routes.js';
import { publicProfileRoutes, readMyProfile, saveMyProfile } from '../src/community/profile.js';
import { githubPhotoTransport, prepareProfilePhoto, readProfilePhoto, validateGithubPhotoUrl } from '../src/community/profile-photos.js';
import { imageModeration } from '../src/projects/image-moderation.js';
import { idTokenFor, resetEmulator, testGithubId, testSubject } from './helpers.js';

let server: Server, base: string, directory: string, at = 1000;
const now = () => at;
const actor = { kind: 'person' as const, operatorId: 'person' };
let image: Buffer;
beforeAll(async () => {
  const app = express(); app.use('/community', communityRoutes(now)); app.use('/api/profiles', publicProfileRoutes(now));
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  image = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ffce32' } }).png().toBuffer();
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
beforeEach(async () => {
  await resetEmulator(); at += 120_000;
  directory = await mkdtemp(join(tmpdir(), 'mlswarm-profile-photo-'));
  vi.stubEnv('MLSWARM_BLOB_DIR', directory);
  imageModeration.moderator = { provider: 'google_vision_safesearch', analyze: async () => ({ responses: [{ safeSearchAnnotation: {
    adult: 'VERY_UNLIKELY', violence: 'VERY_UNLIKELY', racy: 'VERY_UNLIKELY', medical: 'VERY_UNLIKELY', spoof: 'VERY_UNLIKELY' } }] }) };
  await profiles.doc('person').set({ name: 'Person', email: 'person@example.test', removedAt: null });
  await profiles.doc('other').set({ name: 'Other', email: 'other@example.test', removedAt: null });
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); imageModeration.moderator = null; await rm(directory, { recursive: true, force: true }); });
const upload = () => prepareProfilePhoto(actor, randomUUID(), { source: 'upload', mime: 'image/png', bytes: image }, now);
const save = (photo: null | { id: string; publicConsent: true }) => ({
  name: 'Person', bio: '', linkedinProfileUrl: null, expected_revision: 0, client_request_id: randomUUID(), photo,
});
async function request(path: string, token?: string, profileId?: string, body?: object | Buffer, extra: Record<string, string> = {}) {
  return fetch(base + path, { method: body ? 'POST' : 'GET', headers: {
    ...(token ? { authorization: `Bearer ${token}` } : {}), ...(profileId ? { 'x-mlswarm-profile-id': profileId } : {}),
    ...(body ? { 'content-type': Buffer.isBuffer(body) ? 'image/png' : 'application/json' } : {}), ...extra,
  }, ...(body ? { body: Buffer.isBuffer(body) ? new Uint8Array(body) : JSON.stringify(body) } : {}) });
}

test('preparation stays private; only explicit CAS consent publishes sanitized same-origin pixels', async () => {
  const pending = await upload();
  expect((await readMyProfile(actor)).photo).toBeNull();
  await expect(readProfilePhoto('person', pending.id, null, now)).rejects.toMatchObject({ code: 'not_found' });
  const preview = await readProfilePhoto('person', pending.id, actor, now);
  expect((await sharp(preview).metadata()).format).toBe('webp');
  await expect(readProfilePhoto('person', pending.id, { kind: 'person', operatorId: 'other' }, now)).rejects.toThrow();
  await expect(saveMyProfile(actor, { ...save({ id: pending.id, publicConsent: true }), photo: { id: pending.id, publicConsent: false } }, now)).rejects.toMatchObject({ code: 'bad_input' });
  const published = await saveMyProfile(actor, save({ id: pending.id, publicConsent: true }), now);
  expect(published).toMatchObject({ id: 'person', revision: 1, photo: { id: pending.id, url: `/api/profiles/person/photo/${pending.id}` } });
  const response = await request(published.photo!.url);
  expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff'); expect(response.headers.get('content-type')).toContain('image/webp');
});

test('HTTP binds preparation, preview and all profile saves to immutable invitation across same UID reinvite', async () => {
  const token = await idTokenFor('person@example.test');
  expect((await request('/community/my-profile', token, undefined, save(null))).status).toBe(403);
  expect((await request('/community/my-profile/photo/upload', token, 'other', image, { 'x-upload-id': randomUUID() })).status).toBe(403);
  expect((await request('/community/my-profile/photo/upload', undefined, 'person', image, { 'x-upload-id': randomUUID() })).status).toBe(401);
  const response = await request('/community/my-profile/photo/upload', token, 'person', image, { 'x-upload-id': randomUUID() });
  expect(response.status).toBe(200); const pending = await response.json();
  expect((await request(pending.previewPath, token, 'other')).status).toBe(403);
  await profiles.doc('person').update({ removedAt: at });
  await profiles.doc('reinvited').set({ name: 'New invitation', email: 'person@example.test', removedAt: null });
  expect((await request('/community/my-profile', token, 'person', save(null))).status).toBe(403);
  expect((await request(pending.previewPath, token, 'reinvited')).status).toBe(404);
  expect((await profiles.doc('reinvited').get()).data()?.profileRevision).toBeUndefined();
});

test('GitHub source uses only the avatar GitHub reported for the verified account and forbids external URL, redirects and oversized streams', async () => {
  // The person signs in with GitHub through the engine, which records the GitHub account and its avatar.
  await idTokenFor('person@example.test');
  const githubId = testGithubId('person@example.test');
  const githubActor = { ...actor, firebaseUid: testSubject('person@example.test'), verifiedGithubSession: true };
  await githubAccounts.doc(githubId).update({ avatarUrl: 'https://avatars.githubusercontent.com/u/42?v=4' });
  const fetcher = vi.spyOn(githubPhotoTransport, 'fetch').mockResolvedValue(new Response(new Uint8Array(image), { headers: { 'content-type': 'image/png' } }));
  const pending = await prepareProfilePhoto(githubActor, randomUUID(), { source: 'github' }, now);
  expect(pending.source).toBe('github'); expect(fetcher.mock.calls[0][0]).toBe('https://avatars.githubusercontent.com/u/42?v=4');
  expect((await readMyProfile(actor)).photo).toBeNull();
  for (const url of ['http://avatars.githubusercontent.com/a', 'https://avatars.githubusercontent.com.evil.test/a', 'https://127.0.0.1/a', 'https://user:pass@avatars.githubusercontent.com/a', 'https://avatars.githubusercontent.com:444/a']) expect(() => validateGithubPhotoUrl(url)).toThrow();
  fetcher.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://evil.test' } }));
  await expect(prepareProfilePhoto(githubActor, randomUUID(), { source: 'github' }, now)).rejects.toThrow();
  fetcher.mockResolvedValueOnce(new Response(new Uint8Array(2 * 1024 * 1024 + 1), { headers: { 'content-type': 'image/png' } }));
  await expect(prepareProfilePhoto(githubActor, randomUUID(), { source: 'github' }, now)).rejects.toThrow();
  // An account whose GitHub sign-in no longer verifies the profile email offers no photo.
  await githubAccounts.doc(githubId).update({ emails: ['other@example.test'] });
  await expect(prepareProfilePhoto(githubActor, randomUUID(), { source: 'github' }, now)).rejects.toMatchObject({ code: 'bad_input' });
});
