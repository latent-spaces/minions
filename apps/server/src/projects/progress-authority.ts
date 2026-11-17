import { runnerUsage } from '../v2/records.js';
import type { Transaction } from '../firestore.js';
import type { PublishedUpdate } from '@minions/contracts';
import { agents, currentProjectId, profiles, type Agent, type Profile, type WithId } from '../firestore.js';
import { Refusal } from '../errors.js';
import { assertMembership } from './access.js';
import { projects, runtimeOf } from './records.js';
import { assertPublicProject } from './public-access.js';
import { assertRunInTransaction } from '../v2/runs.js';
import { assertCanAct, assertCanDiscuss } from '../store/project-policy.js';

export type ProgressActor = { kind: 'person'; person: WithId<Profile> } | { kind: 'agent'; agent: WithId<Agent>; runId: string };
const label = (name: string) => [...name].slice(0, 120).join('');
export const progressPublisherKey = (actor: ProgressActor) => `${actor.kind}:${actor.kind === 'person' ? actor.person.id : actor.agent.id}`;

// Receipt recovery checks current authority, but does not require a new-action phase gate.
export async function authorizeProgressPublisher(tx: Transaction, actor: ProgressActor): Promise<PublishedUpdate['author']> {
  const profileId = actor.kind === 'person' ? actor.person.id : actor.agent.ownerProfileId;
  await assertMembership(tx, profileId);
  const profile = (await tx.get(profiles.doc(profileId))).data();
  if (!profile) throw new Refusal('unauthorized', 'This person’s Minions account is no longer active.');
  let agentRef: PublishedUpdate['author']['agent'] = null;
  if (actor.kind === 'agent') {
    if (!actor.runId) throw new Refusal('bad_input', 'This agent isn’t working right now, so it can’t publish an update.');
    await assertRunInTransaction(tx, actor.agent.id, actor.runId);
    const current = (await tx.get(agents().doc(actor.agent.id))).data();
    if (!current || current.ownerProfileId !== profileId || current.tokenHash !== actor.agent.tokenHash) throw new Refusal('unauthorized', 'This agent was added again, so this copy can no longer act for it.');
    const provider = (await tx.get(runnerUsage().doc(actor.agent.id))).get('provider');
    agentRef = { id: actor.agent.id, name: label(current.name), ...(provider ? { provider } : {}) };
  }
  return { profile: { id: profileId, name: profile.name }, agent: agentRef };
}

// whilePaused: an agent may still post its update after a project Pause (owner, 10 November 2026, “Short last turn”).
export async function assertNewProgressAction(tx: Transaction, actor: ProgressActor, { whilePaused = false } = {}) {
  const record = (await tx.get(projects.doc(currentProjectId()))).data();
  if (record?.execution.completedAt != null) throw new Refusal('forbidden', 'This project is closed. The owner can reopen it.');
  if (actor.kind !== 'agent') return;
  const runtime = runtimeOf((await tx.get(projects.doc(currentProjectId()))).data());
  if (!runtime) throw new Refusal('not_found', 'This project isn’t set up yet, so agents can’t publish updates.');
  if (runtime.completedAt != null) throw new Refusal('forbidden', 'This project is closed. The owner can reopen it.');
  if (whilePaused) assertCanDiscuss(runtime); else assertCanAct(runtime);
}

export async function authorizeProgressRead(tx: Transaction, actor: ProgressActor | null): Promise<{ audience: 'public' | 'member'; publicConversionAt: number | null }> {
  if (actor) {
    await authorizeProgressPublisher(tx, actor);
    return { audience: 'member', publicConversionAt: null };
  }
  const record = await assertPublicProject(tx);
  return { audience: 'public', publicConversionAt: record.privacy?.visibility === 'public' ? record.privacy.convertedAt : null };
}
