import { beforeEach, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { db } from '../src/firestore.js';
import { fixtureProjectRecords } from '../scripts/project-fixture.js';
import { startScheduledProject, reconcileScheduledStarts } from '../src/projects/scheduled-start.js';
import { resetEmulator } from './helpers.js';
import { reconcileWorker } from '../src/v2/fanout-worker.js';

beforeEach(resetEmulator);
const due = Date.parse('2026-10-18T12:00:00Z');
const owner = { id: 'scheduled-owner' };
const idOf = (name: string) => createHash('sha256').update(name).digest('hex');
function records(name: string, deadline = new Date(due).toISOString()) {
  const id = idOf(name);
  const entries = fixtureProjectRecords(id, { ownerProfileId: owner.id,
    definition: { title: name, goal: 'Scheduled collaboration', rules: 'Isolated', mergeApproval: 'humans' },
    runtime: { revision: 1, configuredAt: due - 1000, configuredBy: owner.id, setupFinalizedAt: due - 1000,
      repoUrl: 'https://github.com/example/schedule', startsAt: 0,
      started: false, paused: true, awaitingKickoff: true,
      minContributors: 20, startDeadline: deadline } });
  const main = entries[0].body as any;
  main.publication = { listed: true, revision: 1 };
  entries.push({ path: `projectListings/${id}`, body: { workspaceId: main.workspaceId, title: name, summary: 'Scheduled collaboration', category: 'community', tags: [], ownerName: 'Owner', revision: 1, publishedAt: due - 1000, updatedAt: due - 1000, prefixes: [] } });
  return { id, entries, main };
}
async function save(...fixtures: ReturnType<typeof records>[]) {
  const batch = db.batch();
  for (const fixture of fixtures) for (const entry of fixture.entries) batch.set(db.doc(entry.path), entry.body);
  await batch.commit();
  return fixtures[0].id;
}
async function evidence(id: string) {
  const [project, history, fanout] = await Promise.all([db.doc(`projects/${id}`).get(), db.collection(`projects/${id}/projectHistory`).get(), db.collection(`projects/${id}/fanouts`).get()]);
  return { project: project.data(), history: history.docs.map(row => row.data()), fanout: fanout.docs.map(row => row.data()) };
}

test('starts exactly at the saved second without a contributor minimum or native execution mutation', async () => {
  const id = await save(records('seconds', '2026-10-18T12:00:00Z'));
  const session = db.doc(`projects/${id}/sessions/existing`), agent = db.doc(`projects/${id}/agents/existing`);
  await session.set({ deadlineAt: due + 10000, status: 'paused' });
  await agent.set({ executionAllowed: false });
  expect(await reconcileScheduledStarts(() => due - 1)).toMatchObject({ started: 0 });
  expect(await reconcileScheduledStarts(() => due)).toMatchObject({ started: 1 });
  const state = await evidence(id);
  expect(state.project).toMatchObject({ revision: 2, execution: { started: true, paused: false, awaitingKickoff: false, startsAt: due } });
  expect(state.history).toHaveLength(1);
  expect(state.history[0]).toMatchObject({ at: due, scheduledAt: due, source: 'scheduled_start', operatorId: null });
  expect(state.fanout).toHaveLength(1);
  expect(state.fanout[0].kind).toBe('project_started');
  expect((await db.doc(`projects/${id}/announcements/start`).get()).data()).toEqual({ revision: 2, startedAt: due, actorName: null, scheduled: true });
  expect((await session.get()).data()).toEqual({ deadlineAt: due + 10000, status: 'paused' });
  expect((await agent.get()).data()).toEqual({ executionAllowed: false });
});

test('a scheduled start adds the default length to time already given, like a manual start, within 24 hours', async () => {
  const fresh = await save(records('fresh-length'));
  await startScheduledProject(fresh, () => due + 1000);
  expect((await evidence(fresh)).project).toMatchObject({ execution: { endsAt: due + 1000 + 60 * 60_000 } });
  const given = records('given-length'); given.main.execution.endsAt = due + 30 * 60_000;
  const id = await save(given);
  await startScheduledProject(id, () => due + 1000);
  expect((await evidence(id)).project).toMatchObject({ execution: { endsAt: due + 90 * 60_000 } });
  const full = records('full-length'); full.main.execution.endsAt = due + 23.5 * 3600_000;
  const capped = await save(full);
  await startScheduledProject(capped, () => due);
  expect((await evidence(capped)).project).toMatchObject({ execution: { endsAt: due + 24 * 3600_000 } });
});

test('concurrent scheduler retries commit one revision, history and fanout and preserve scheduled time when late', async () => {
  const id = await save(records('fractional', '2026-10-18T12:00:00.123Z'));
  const results = await Promise.all([startScheduledProject(id, () => due + 90000), startScheduledProject(id, () => due + 90000)]);
  expect(results.filter(result => result.started)).toHaveLength(1);
  expect(await evidence(id)).toMatchObject({ project: { revision: 2, execution: { startsAt: due + 123 } } });
  expect((await evidence(id)).history).toHaveLength(1);
  expect((await evidence(id)).fanout).toHaveLength(1);
});

test('existing projects with retired voting fields still start on schedule', async () => {
  const id = await save(records('retired-voting-policy'));
  await db.doc(`projects/${id}`).update({ 'approval.proposedGovernance': null,
    'setup.governance': null, 'setup.minCountdownS': 60, 'setup.maxCountdownS': 86400 });
  expect(await reconcileScheduledStarts(() => due)).toMatchObject({ started: 1, failed: 0 });
  const state = await evidence(id);
  expect(state.project!.execution.started).toBe(true);
  expect(state.history).toHaveLength(1);
  expect(state.fanout).toHaveLength(1);
});

test('fresh eligibility excludes paused started, closed, private, unconfigured, unfinalized and unpublished records', async () => {
  const fixtures = ['paused', 'closed', 'private', 'unconfigured', 'unfinalized', 'unpublished', 'future', 'invalid', 'missing-card', 'missing-listing'].map(name => records(name));
  fixtures[0].main.execution = { ...fixtures[0].main.execution, started: true, awaitingKickoff: false };
  fixtures[1].main.execution.completedAt = due - 1;
  fixtures[2].main.privacy = { visibility: 'private', messageProtection: 'server_readable_v1', createdAt: due - 1000 }; fixtures[2].main.approval = null; fixtures[2].main.setup.required = false; fixtures[2].main.publication.listed = false;
  fixtures[3].main.setup = { ...fixtures[3].main.setup, configuredAt: null, configuredByProfileId: null, repoUrl: null, finalizedAt: null }; fixtures[3].main.publication.listed = false;
  fixtures[4].main.setup.finalizedAt = null;
  fixtures[5].main.publication.listed = false;
  fixtures[6].main.setup.startDeadline = new Date(due + 1).toISOString();
  fixtures[7].main.setup.startDeadline = 'invalid date';
  fixtures[8].entries = fixtures[8].entries.filter(entry => !entry.path.endsWith('/card/current'));
  fixtures[9].entries = fixtures[9].entries.filter(entry => !entry.path.startsWith('projectListings/'));
  await save(...fixtures);
  for (const fixture of fixtures) expect(await startScheduledProject(fixture.id, () => due)).toMatchObject({ started: false });
  for (const fixture of fixtures) expect((await evidence(fixture.id)).history).toHaveLength(0);
});

test('the periodic reconciler starts a due private project', async () => {
  const id = await save(records('private-worker'));
  expect((await evidence(id)).project!.execution.started).toBe(false);
  const result = await reconcileWorker(async () => ({ selected: 0, refused: 0, oldestDueSeconds: null }), () => due);
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({ scheduledStarts: { scanned: 1, started: 1, failed: 0 } });
  expect((await evidence(id)).project!.execution.started).toBe(true);
});
