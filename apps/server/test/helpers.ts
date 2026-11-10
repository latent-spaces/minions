import { prepareUsageProgress } from '../src/v2/usage-progress.js';
import { stopProjectUsage } from '../src/view/project-usage.js';
import { prepareCurrentStateProgress } from '../src/view/current-state-progress.js';
import { writeCreatedAgentStatus } from '../src/v2/agent-group.js';
import { presence } from '../src/v2/records.js';
import { CURRENT_STATE_CUTOVER_RECEIPT } from '../src/view/current-state-cutover.js';
import type { RequestHandler } from 'express';
import { createHash } from 'node:crypto';
import { issueGithubSession } from '../src/identity/server-sessions.js';
import { hashToken, newToken } from '../src/auth.js';
import { seedFixtureProject, type FixtureProject } from '../scripts/project-fixture.js';
import { recordWithRuntime, runtimeWithCard, type WorkspaceProject } from '../src/projects/records.js';
import { cardDoc } from '../src/projects/card.js';
import { Refusal } from '../src/errors.js';
import { agents, currentProjectId, db, inProject, profiles, projectDoc, type Agent, type Project, type WithId } from '../src/firestore.js';
import { currentConnectionEpoch, membershipDoc, membershipEpoch, membershipFenceDoc, membershipsOf, type Membership } from '../src/projects/access.js';
import { disposableTarget } from '../../../tests/support/disposable-session.mjs';

// Clears every document (and with them every sign-in account and session) in the disposable test session's store.
export async function resetEmulator(): Promise<void> {
  disposableTarget();
  stopProjectUsage();
  (db as unknown as { reset(): void }).reset();
  await seedCurrentStateReady();
}

// Disposable control fixture only; production admission is an explicit operator action.
export const seedCurrentStateReady = () => db.doc(CURRENT_STATE_CUTOVER_RECEIPT).set({
  schema: 2, epoch: 'sequence-v1', usageEpoch: 'usage-sequence-v1', writerSource: 'a'.repeat(40), evidenceSha256: 'b'.repeat(64),
});

export const testProject: Project = {
  name: 'Test game',
  mission: 'Build an open-world 2D top-down browser game.',
  rules: 'Outcome: Evidence\nRules: Isolated\nAcceptance: Tests',
  repoUrl: 'https://github.com/example/game',
  startsAt: 0,
  paused: false,
  started: true,
};

// The workspace the helpers below seed and read. Called inside another workspace, they use that one instead.
export const TEST_PROJECT = '7e57'.repeat(16);
const workspace = () => { try { return currentProjectId(); } catch { return TEST_PROJECT; } };
const inWorkspace = <T>(work: () => T): T => inProject(workspace(), work);

// Canonical admission fixture: parent, immutable approval, current Card/v1, community settings/rules.
export const seedApprovedProject = (id: string, input: FixtureProject) => seedFixtureProject(id, input);

// Change fixture execution/settings through the main record instead of writing a flat runtime document.
export async function seedRuntime(id: string, patch: Partial<WorkspaceProject>): Promise<void> {
  await inProject(id, () => db.runTransaction(async tx => {
    const [main, card] = await Promise.all([tx.get(projectDoc()), tx.get(cardDoc(id))]);
    if (!main.exists || !card.exists) throw new Error('Seed project admission before its runtime.');
    const record = main.data()!;
    const runtime = { ...testProject, revision: record.revision, configuredAt: 0,
      configuredBy: record.ownerProfileId, setupFinalizedAt: 0,
      ...runtimeWithCard(record, card.data()), ...patch, ...(patch.started === true && patch.awaitingKickoff === undefined ? { awaitingKickoff: false } : {}) };
    tx.set(projectDoc(), recordWithRuntime(record, runtime));
    if (patch.name !== undefined || patch.mission !== undefined) tx.set(cardDoc(id), {
      ...card.data()!, definition: { ...card.data()!.definition,
        ...(patch.name !== undefined ? { title: patch.name } : {}), ...(patch.mission !== undefined ? { goal: patch.mission } : {}) },
    });
  }));
}

// Serves a router in the test workspace, as the /p/<project id> mount does.
export const scoped = (router: RequestHandler): RequestHandler => (req, res, next) => inProject(TEST_PROJECT, () => router(req, res, next));

// Sets a person's membership in a project directly: 'active' joins, as a public join does; an ended status raises the
// connection generation, as leaving does. Members can no longer be added or removed by the owner.
export async function setTestMembership(projectId: string, profileId: string, status: Membership['status'] = 'active', at = 0) {
  await db.runTransaction(async tx => {
    const [previous, fence] = await Promise.all([tx.get(membershipDoc(projectId, profileId)), tx.get(membershipFenceDoc(projectId, profileId))]);
    const epoch = membershipEpoch(projectId, profileId, previous.data(), fence.data()) + (status === 'active' ? 0 : 1);
    const member: Membership = { profileId, projectId, role: 'member', status, statusChangedAt: at, restrictions: { chatMutedUntil: null },
      revision: (previous.data()?.revision ?? 0) + 1, updatedAt: at, connectionEpoch: epoch };
    tx.set(membershipFenceDoc(projectId, profileId), { profileId, projectId, epoch });
    tx.set(membershipDoc(projectId, profileId), member); tx.set(membershipsOf(profileId).doc(projectId), member);
  });
}

type SeedPerson = { name: string; email: string; role?: 'owner' | 'member' };
type SeedAgent = { person: number; name: string };  // person is an index into profiles

// Creates the project document, profiles and agents. The test workspace is also approved. Its owner is the
// person seeded with role 'owner', or else an owner that has no account; each other person joins it as a
// member, in both membership records.
// In another workspace, its approval and memberships are the caller's.
// Returns ids, and agents' raw tokens, in input order.
export async function seed(opts: { project?: Partial<Project>; profiles?: SeedPerson[]; agents?: SeedAgent[] } = {}) {
  return inWorkspace(async () => {
    const project = { ...testProject, ...opts.project }, approved = currentProjectId() === TEST_PROJECT;
    const refs = (opts.profiles ?? []).map(() => profiles.doc());
    const ownerIndex = (opts.profiles ?? []).findIndex(p => p.role === 'owner');
    const ownerProfileId = ownerIndex >= 0 ? refs[ownerIndex].id : 'seed-owner';
    const existing = await projectDoc().get();
    if (existing.exists) {
      const { name, mission, rules, ...controls } = testProject;
      await seedRuntime(currentProjectId(), { ...controls, ...opts.project });
    }
    else await seedFixtureProject(currentProjectId(), {
      ownerProfileId, required: false,
      definition: { title: project.name, goal: project.mission, beneficiaries: 'Tests', output: 'Evidence', scope: 'Isolated', acceptanceCriteria: 'Tests', sources: null, resources: null, mergeApproval: 'humans' },
      runtime: { ...project, revision: 0, configuredAt: 0, configuredBy: ownerProfileId, setupFinalizedAt: 0,
        },
    });
    const personIds: string[] = [];
    for (const [index, p] of (opts.profiles ?? []).entries()) {
      const ref = refs[index];
      await ref.set({ name: p.name, email: p.email.toLowerCase(), removedAt: null });
      if (approved) {
        const member: Membership = { profileId: ref.id, projectId: TEST_PROJECT, role: 'member', status: 'active', statusChangedAt: 0, restrictions: { chatMutedUntil: null }, revision: 1, updatedAt: 0, connectionEpoch: 0 };
        await membershipDoc(TEST_PROJECT, ref.id).set(member);
        await membershipsOf(ref.id).doc(TEST_PROJECT).set(member);
      }
      personIds.push(ref.id);
    }
    const seededAgents: { agentId: string; token: string }[] = [];
    for (const a of opts.agents ?? []) {
      seededAgents.push(await addAgent(personIds[a.person], a.name, () => 1_000));
    }
    return { personIds, agents: seededAgents };
  });
}


export async function loadAgent(agentId: string): Promise<WithId<Agent>> {
  return inWorkspace(async () => ({ id: agentId, ...(await agents().doc(agentId).get()).data()! }));
}

// An agent of an active member of the workspace, with the member's connection generation.
// The token is returned once and never stored.
export async function addAgent(personId: string, name: string, now: () => number):
  Promise<{ agentId: string, token: string }> {
  return inWorkspace(async () => {
    const token = newToken();
    const ref = agents().doc();
    const trimmed = name.trim();
    await db.runTransaction(async (tx) => {
      const connectionEpoch = await currentConnectionEpoch(tx, personId);
      const person = await tx.get(profiles.doc(personId));
      if (!person.exists || person.data()!.removedAt !== null) throw new Refusal('not_found', 'No such person.');
      const owned = await tx.get(agents().where('ownerProfileId', '==', personId).where('name', '==', trimmed).where('revokedAt', '==', null)
        .where('connectionEpoch', '==', connectionEpoch).limit(1));
      if (!owned.empty) throw new Refusal('duplicate', `You already have an agent named ${trimmed}.`);
      const statusProgress = await prepareCurrentStateProgress(tx, [presence().doc(ref.id)]);
      const usageProgress = await prepareUsageProgress(tx, [ref.id]);
      usageProgress(ref.id, 'created');
      tx.set(ref, { ownerProfileId: personId, connectionEpoch, name: trimmed, tokenHash: hashToken(token), createdAt: now(), revokedAt: null , tokenIssuedAt: now() });
      writeCreatedAgentStatus(tx, presence().doc(ref.id), { ownerProfileId: personId, connectionEpoch, name: trimmed, revokedAt: null }, statusProgress);
    });
    return { agentId: ref.id, token };
  });
}

// A synthetic GitHub account per email: the same email always reaches the same account and sign-in subject.
export const testGithubId = (email: string) => String(BigInt(`0x${createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0, 12)}`) + 1n);
export const testGithubLogin = (email: string) => `test-${createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0, 8)}`;
export const testSubject = (email: string) => `github-${testGithubId(email)}`;

// Signs in as the engine does after GitHub confirms an account with this verified email, returning a session token.
export async function idTokenFor(email: string, now: () => number = Date.now): Promise<string> {
  disposableTarget();
  return (await issueGithubSession({ githubId: testGithubId(email), login: testGithubLogin(email), name: null, avatarUrl: null, emails: [email] }, now)).token;
}
