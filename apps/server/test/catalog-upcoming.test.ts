import { beforeAll, afterAll, beforeEach, expect, test } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { projectDiscoveryRoutes } from '../src/projects/discovery.js';
import { createHash } from 'node:crypto';
import { createProjectRecord, projects } from '../src/projects/records.js';
import { cardDoc } from '../src/projects/card.js';
import { readCatalog, readStartingSoon, projectListings, searchPrefixes } from '../src/projects/catalog.js';
import { resetEmulator } from './helpers.js';
import { db } from '../src/firestore.js';

const now = Date.parse('2026-10-18T12:00:00Z'), day = 86400000;
const idFor = (name: string) => createHash('sha256').update(name).digest('hex');
let server: Server, base: string;
beforeAll(async () => {
  const app = express(); app.use('/api/discovery/projects', projectDiscoveryRoutes(() => now));
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
beforeEach(resetEmulator);
async function listed(name: string, offset: number, options: { category?: 'games' | 'research'; publishedAt?: number; started?: boolean; closed?: boolean; unlisted?: boolean } = {}) {
  const id = idFor(name), definition = { title: name, goal: 'Shared goal', beneficiaries: '', output: '', scope: '', acceptanceCriteria: '', sources: null, resources: null, mergeApproval: 'humans' as const, minContributors: 5 };
  const base = createProjectRecord('owner', 'reviewer', id, 1, definition, 1);
  const record = { ...base, setup: { ...base.setup, configuredAt: 1, configuredByProfileId: 'owner', repoUrl: 'https://github.com/example/work', finalizedAt: 1, startDeadline: new Date(now + offset).toISOString() },
    publication: { listed: !options.unlisted, revision: 1 }, execution: { ...base.execution, started: options.started ?? false, awaitingKickoff: !options.started, paused: !options.started, startsAt: options.started ? 2 : 0, completedAt: options.closed ? 3 : null } };
  await projects.doc(id).set(record);
  await cardDoc(id).set({ version: 1, definition, at: 1, editorProfileId: 'owner' });
  await projectListings.doc(id).set({ workspaceId: base.workspaceId, title: name, summary: 'Shared goal', category: options.category ?? 'research', tags: [], ownerName: 'Owner', revision: 1, publishedAt: options.publishedAt ?? 1, updatedAt: 1, prefixes: searchPrefixes(name, []) });
  return id;
}
test('upcoming selection spans results pages and applies search, category and exact date range', async () => {
  const soon = await listed('Garden earliest', 1000, { publishedAt: 1 });
  for (let i = 0; i < 21; i++) await listed(`Garden later ${i}`, 3 * day, { publishedAt: 100 + i });
  await listed('Garden other category', 500, { category: 'games' });
  await listed('Garden too late', 7 * day + 1);
  const week = await listed('Garden week', 7 * day);
  await listed('Garden already active', 100, { started: true });
  await listed('Garden closed', 200, { closed: true });
  await listed('Garden unlisted', 300, { unlisted: true });
  await listed('Different word', 400);
  const page = await readCatalog({ q: 'garden', category: 'research' }, () => now);
  expect(page.projects.map(p => p.id)).not.toContain(soon);
  const upcoming = await readStartingSoon({ q: 'garden', category: 'research' }, () => now);
  expect(upcoming).toHaveLength(3);
  expect(upcoming[0].id).toBe(soon);
  const actual = await fetch(`${base}/api/discovery/projects?q=garden&category=research&cursor=${encodeURIComponent(page.next!)}`);
  expect(actual.status).toBe(200);
  expect((await actual.json()).startingSoon.map((p: { id: string }) => p.id)).toEqual(upcoming.map(p => p.id));
  expect(upcoming.every(p => p.category === 'research' && p.title.startsWith('Garden'))).toBe(true);
  const onSecondPage = await readCatalog({ q: 'garden', category: 'research', cursor: page.next! }, () => now);
  expect(onSecondPage.projects.some(p => p.id === soon || p.id === week)).toBe(true);
  expect((await readStartingSoon({ q: 'garden', category: 'research' }, () => now)).map(p => p.id)).toEqual(upcoming.map(p => p.id));
});

test('existing projects with retired voting fields remain in upcoming discovery', async () => {
  const id = await listed('Garden legacy', 1000);
  await db.doc(`projects/${id}`).update({ 'approval.proposedGovernance': null,
    'setup.governance': null, 'setup.minCountdownS': 60, 'setup.maxCountdownS': 86400 });
  expect((await readStartingSoon({}, () => now)).map(project => project.id)).toEqual([id]);
});
