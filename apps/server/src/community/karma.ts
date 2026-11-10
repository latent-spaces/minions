import { agents, db, inProject, profiles } from '../firestore.js';
import { computerSetupStatus } from '../projects/computer-setup.js';
import { humanChatSendState } from '../projects/chat.js';
import { membershipsOf } from '../projects/access.js';
import { projects } from '../projects/records.js';
import { Refusal } from '../errors.js';
import { proposals } from './records.js';
import type { CommunityActor } from './identity.js';

// The onboarding steps the person has done, for the Karma bar (owner, 22 October 2026). Step names, points and
// copy live in the web app (ui/karma-steps.ts); this only answers which are done, from records that already exist.
export type KarmaStep = 'sign-in' | 'photo' | 'computer' | 'github' | 'join' | 'chat' | 'agent' | 'create';
// Bounded reads: a person past these limits has long finished onboarding.
const PROJECTS = 20;

export async function karmaProgress(actor: Pick<CommunityActor, 'operatorId'>, now: () => number = Date.now) {
  const id = actor.operatorId;
  const [profile, setup, joined, owned, proposed] = await Promise.all([
    profiles.doc(id).get(),
    db.runTransaction(tx => computerSetupStatus(tx, id, now())),
    membershipsOf(id).where('status', '==', 'active').limit(PROJECTS).get(),
    projects.where('ownerProfileId', '==', id).limit(PROJECTS).get(),
    proposals.where('ownerProfileId', '==', id).limit(1).get(),
  ]);
  if (!profile.exists || profile.data()!.removedAt !== null) throw new Refusal('unauthorized', 'Your MyLittleSwarm account is no longer active.');
  const person = profile.data()!;
  const projectIds = [...new Set([...joined.docs.map(m => m.data().projectId), ...owned.docs.map(p => p.id)])].slice(0, PROJECTS);
  const perProject = await Promise.all(projectIds.map(projectId => inProject(projectId, async () => {
    const [sent, mine] = await Promise.all([humanChatSendState(projectId).doc(id).get(), agents().where('ownerProfileId', '==', id).limit(1).get()]);
    return { chatted: sent.exists, agent: !mine.empty };
  })));
  const done: Record<KarmaStep, boolean> = {
    'sign-in': true,
    photo: !!person.photo,
    computer: setup.computerComplete,
    github: setup.githubComplete,
    join: !joined.empty,
    chat: perProject.some(p => p.chatted),
    agent: perProject.some(p => p.agent),
    create: !owned.empty || !proposed.empty,
  };
  return { done: (Object.keys(done) as KarmaStep[]).filter(step => done[step]) };
}
