import { isPrivateProject } from '../projects/schema.js';
import { createHash } from 'node:crypto';
import type { Transaction } from '../firestore.js';
import type { OnboardingStep } from '@minions/contracts';
import { collection, db, inProject, type Profile, type WithId } from '../firestore.js';
import { projects } from '../projects/records.js';
import { assertMembership } from '../projects/access.js';
import { computerSetupStatus } from '../projects/computer-setup.js';

// Stored journeys may still carry the former invitation and shared-link sources.
export type JourneySource = 'invitation' | 'shared_link' | 'membership';
export type ProjectJourney = {
  profileId: string; projectId: string; enteredAt: number; source: JourneySource; recordingFromEntry: boolean;
  invitationId?: string;
  milestones: Partial<Record<OnboardingStep, number>>;
  reused: { computer: boolean; github: boolean };
  humanActivity: { firstAt: number | null; lastAt: number | null; chatMessages: number; steeringCommands: number };
};
export const projectJourneys = collection<ProjectJourney>('onboardingJourneys');
export const journeyId = (profileId: string, projectId: string) => createHash('sha256').update(JSON.stringify([profileId, projectId])).digest('hex');
/** Read before any action writes; the returned commit joins the authoritative action's transaction.
 * One person's events in another project cannot advance this journey. Shared-link creation is never an invite time.
 */
export async function prepareProjectJourney(tx: Transaction, profileId: string, projectId: string, at: number) {
  const ref = projectJourneys.doc(journeyId(profileId, projectId));
  const [record, project] = await Promise.all([tx.get(ref), tx.get(projects.doc(projectId))]);
  if (!isPrivateProject(project.data())) return (_steps: readonly OnboardingStep[], _action?: 'chat' | 'steering') => {};
  const saved = record.data();
  const setup = !saved ? await computerSetupStatus(tx, profileId, at) : null;
  return (steps: readonly OnboardingStep[], action?: 'chat' | 'steering') => {
    const milestones = { ...saved?.milestones };
    let changed = !saved;
    for (const step of steps) if (milestones[step] === undefined) { milestones[step] = at; changed = true; }
    if (!changed && !action) return;
    const activity = saved?.humanActivity ?? { firstAt: null, lastAt: null, chatMessages: 0, steeringCommands: 0 };
    tx.set(ref, { profileId, projectId, enteredAt: saved?.enteredAt ?? at, source: saved?.source ?? 'membership', recordingFromEntry: saved?.recordingFromEntry ?? false,
      ...(saved?.invitationId ? { invitationId: saved.invitationId } : {}),
      milestones, reused: saved?.reused ?? { computer: setup!.computerComplete, github: setup!.githubComplete },
      humanActivity: action ? { firstAt: activity.firstAt ?? at, lastAt: Math.max(activity.lastAt ?? at, at), chatMessages: activity.chatMessages + Number(action === 'chat'), steeringCommands: activity.steeringCommands + Number(action === 'steering') } : activity });
  };
}
/** Narrow authenticated browser observation. A visit records no active minutes or participation. */
export async function recordProjectVisit(person: WithId<Profile>, projectId: string, now: () => number) {
  return inProject(projectId, () => db.runTransaction(async tx => {
    await assertMembership(tx, person.id);
    const progress = await prepareProjectJourney(tx, person.id, projectId, now());
    progress(['firstVisit']); return { observed: true as const };
  }));
}
