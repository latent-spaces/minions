import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { imageModeration } from '../src/projects/image-moderation.js';
import { inProject, profiles, collection } from '../src/firestore.js';
import { membershipDoc } from '../src/projects/access.js';
import { publishProgressUpdate, readProgressUpdates } from '../src/projects/progress.js';
import { uploadProgressScreenshot, readProgressScreenshot } from '../src/projects/progress-media.js';
import { resetEmulator, seed, TEST_PROJECT } from './helpers.js';

let directory: string;
beforeEach(async () => {
  imageModeration.moderator = { provider: 'google_vision_safesearch', analyze: async () => ({ responses: [{ safeSearchAnnotation: { adult: 'VERY_UNLIKELY', violence: 'VERY_UNLIKELY', racy: 'VERY_UNLIKELY', medical: 'VERY_UNLIKELY', spoof: 'VERY_UNLIKELY' } }] }) };
  await resetEmulator();
  directory = await mkdtemp(join(tmpdir(), 'mlswarm-update-feed-'));
  vi.stubEnv('MLSWARM_BLOB_DIR', directory);
});
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); imageModeration.moderator = null;
  await rm(directory, { recursive: true, force: true });
});

test('one feed preserves text, outputs and images once across pages, while retaining fresh member access', async () => {
  const f = await seed({ profiles: [{ name: 'Participant', email: 'participant@example.test' }] });
  const person = { id: f.personIds[0], ...(await profiles.doc(f.personIds[0]).get()).data()! };
  const actor = { kind: 'person' as const, person };
  const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ffce32' } }).png().toBuffer();
  const upload = await uploadProgressScreenshot(TEST_PROJECT, actor, 'image', 'image/png', bytes, () => 1000);
  const published = [];
  for (let n = 0; n < 24; n++) {
    // Text-only records represent immutable history from before the visual cutover.
    const input = { clientRequestId: 'post-' + n, body: 'Progress ' + n,
      links: n === 2 ? [{ url: 'https://example.com/demo', label: 'Try the demo', purpose: 'result' as const }] : [] };
    const receipt = n === 3 ? await publishProgressUpdate(TEST_PROJECT, actor, { ...input,
      screenshot: { uploadId: upload.uploadId, alt: 'A small test image', representation: 'concept_image' } }, () => 2000 + Math.floor(n / 2))
      : { update: { kind: 'authored_update' as const, id: n.toString(16).padStart(64, '0'), projectId: TEST_PROJECT,
          author: { profile: { id: person.id, name: person.name!, photo: null }, agent: null }, title: null,
          body: input.body, links: input.links.map(link => ({ ...link, availability: 'unknown' as const })),
          screenshot: null, publishedAt: 2000 + Math.floor(n / 2) } };
    if (n !== 3) await collection(`projects/${TEST_PROJECT}/updates`).doc(receipt.update.id).set({
      ...receipt.update, hasResult: input.links.length > 0 });
    published.push(receipt.update);
  }
  const newest = [...published].sort((a, b) => b.publishedAt - a.publishedAt || b.id.localeCompare(a.id));
  const first = await readProgressUpdates(TEST_PROJECT, actor, {}, () => 3000);
  expect(first.items).toHaveLength(20);
  expect(first.next).not.toBeNull();
  const earlier = await readProgressUpdates(TEST_PROJECT, actor, { cursor: first.next! }, () => 3000);
  const all = [...first.items, ...earlier.items];
  expect(all).toEqual(newest);
  expect(new Set(all.map(item => item.id)).size).toBe(24);
  expect(earlier.next).toBeNull();
  expect(all.find(item => item.screenshot)?.screenshot).toMatchObject({ alt: 'A small test image', representation: 'concept_image' });
  expect(all.find(item => item.links.length)?.links[0]).toMatchObject({ purpose: 'result', availability: 'unknown' });
  expect((await readProgressScreenshot(TEST_PROJECT, actor, upload.uploadId)).mimeType).toBe('image/webp');
  // Published beta.17 clients retain their optional filter over this same feed.
  expect((await readProgressUpdates(TEST_PROJECT, actor, { source: 'result_history' }, () => 3000)).items).toHaveLength(2);
  await inProject(TEST_PROJECT, () => membershipDoc(TEST_PROJECT, person.id).update({ status: 'removed' }));
  await expect(readProgressUpdates(TEST_PROJECT, actor, { cursor: first.next! }, () => 3000)).rejects.toThrow();
  await expect(readProgressScreenshot(TEST_PROJECT, actor, upload.uploadId)).rejects.toThrow();
});

test('Me + my agents update pages include only the reader and their agents, with filter-scoped cursors', async () => {
  const f = await seed({ profiles: [{ name: 'Me', email: 'me@example.test' }, { name: 'Other', email: 'other@example.test' }] });
  const actor = { kind: 'person' as const, person: { id: f.personIds[0], ...(await profiles.doc(f.personIds[0]).get()).data()! } };
  const other = { kind: 'person' as const, person: { id: f.personIds[1], ...(await profiles.doc(f.personIds[1]).get()).data()! } };
  for (let n = 0; n < 66; n++) {
    const id = n.toString(16).padStart(64, '0'), mine = n % 2 === 0;
    await collection(`projects/${TEST_PROJECT}/updates`).doc(id).set({
      id, kind: 'authored_update', projectId: TEST_PROJECT, title: null, body: 'Update ' + n,
      author: { profile: { id: f.personIds[mine ? 0 : 1], name: mine ? 'Me' : 'Other' }, agent: n % 4 === 0 ? { id: 'my-agent', name: 'My agent' } : null },
      links: [], screenshot: null, publishedAt: 1000 + Math.floor(n / 3), hasResult: false,
    });
  }
  const first = await readProgressUpdates(TEST_PROJECT, actor, { authors: 'mine' }, () => 3000);
  const earlier = await readProgressUpdates(TEST_PROJECT, actor, { authors: 'mine', cursor: first.next! }, () => 3000);
  const items = [...first.items, ...earlier.items];
  expect(items).toHaveLength(33);
  expect(new Set(items.map(item => item.id)).size).toBe(33);
  expect(items.every(item => item.author.profile.id === actor.person.id)).toBe(true);
  expect(items.some(item => item.author.agent)).toBe(true);
  expect(items.some(item => !item.author.agent)).toBe(true);
  expect(earlier.next).toBeNull();
  await expect(readProgressUpdates(TEST_PROJECT, actor, { cursor: first.next! }, () => 3000)).rejects.toThrow();
  await expect(readProgressUpdates(TEST_PROJECT, other, { authors: 'mine', cursor: first.next! }, () => 3000)).rejects.toThrow();
  await expect(readProgressUpdates(TEST_PROJECT, null, { authors: 'mine' }, () => 3000)).rejects.toThrow();
});
