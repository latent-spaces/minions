import { beforeEach, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { profiles, inProject } from '../src/firestore.js';
import { resetEmulator } from './helpers.js';
import { writeProposal, reviewProposal } from '../src/community/proposals.js';
import { projects } from '../src/projects/records.js';
import { readWorkspace } from '../src/projects/store.js';
import { readCommunication } from '../src/projects/communication.js';
import { cardDoc } from '../src/projects/card.js';
import { SETUP_PLAN } from '../src/projects/setup-schema.js';

beforeEach(resetEmulator);
test('public setup remains a proposal until approval, initializes limits once and keeps owner planning notes out of the Card', async () => {
  const owner = { id: 'setup-owner', name: 'Owner', email: 'owner@example.test', removedAt: null };
  const reviewer = { id: 'setup-reviewer', name: 'Reviewer', email: 'reviewer@example.test', removedAt: null };
  await profiles.doc(owner.id).set(owner); await profiles.doc(reviewer.id).set(reviewer);
  const setupPlan = { peopleNote: 'Private owner planning note',
    communication: { defaults: { broadcastAllowed: true, sendsPerHour: 25, minimumGapSeconds: 15, broadcastsPerHour: 2 }, sharedBroadcastsPerHour: 4 } };
  const actor = { kind: 'person' as const, operatorId: owner.id };
  const draft = await writeProposal(actor, { action: 'draft', clientId: randomUUID(), content: {
    title: 'Public setup', goal: 'Build together', githubUrl: 'https://github.com/example/public', proposalFormat: 'simple', minContributors: 1,
    agentGuidance: 'Explain outputs.', setupPlan,
  } }, Date.now);
  const id = draft.proposal.id;
  const submitted = await writeProposal(actor, { action: 'submit', proposalId: id, expectedRevision: draft.proposal.revision, clientId: randomUUID() }, Date.now);
  expect((await projects.doc(id).get()).exists).toBe(false);
  const approval = { proposalId: id, expectedRevision: submitted.proposal.revision, clientId: randomUUID(), decision: 'approved' as const, feedback: 'Approved.' };
  await reviewProposal({ kind: 'person', operatorId: reviewer.id, adminAuthenticated: true }, approval, Date.now);
  await reviewProposal({ kind: 'person', operatorId: reviewer.id, adminAuthenticated: true }, approval, Date.now);
  expect((await projects.doc(id).get()).data()).toMatchObject({ setupPlan, publication: { listed: false }, execution: { started: false, paused: true } });
  expect((await cardDoc(id).get()).data()!.definition).toMatchObject({ agentGuidance: 'Explain outputs.' });
  expect((await cardDoc(id).get()).data()!.definition).not.toHaveProperty('setupPlan');
  expect((await readWorkspace(owner, id)).setupPlan).toEqual(setupPlan);
  expect(await inProject(id, () => readCommunication(owner.id))).toMatchObject({ effective: { sendsPerHour: 25, sharedBroadcastsPerHour: 4, projectRevision: 1 } });
});

test('a planned role saved before the one-person decision still reads and is dropped', () => {
  const plan = { peopleNote: '', communication: { defaults: { broadcastAllowed: true, sendsPerHour: 25, minimumGapSeconds: 15, broadcastsPerHour: 2 }, sharedBroadcastsPerHour: 4 } };
  expect(SETUP_PLAN.parse({ ...plan, plannedRole: 'moderator' })).toEqual(plan);
});
