import { isPrivateProject } from '../projects/schema.js';
import { ONBOARDING_STEPS, type OnboardingTimings, type OnboardingStep } from '@minions/contracts';
import { z } from 'zod';
import { db, profiles } from '../firestore.js';
import { assertCommunityActor, type CommunityActor } from '../community/identity.js';
import { onboardingProgress, type AccountStep } from '../onboarding/progress.js';
import { projectJourneys } from '../onboarding/journeys.js';
import { projects } from '../projects/records.js';
import { cardDoc } from '../projects/card.js';
import { Refusal } from '../errors.js';
const LIMIT = 500, DAY = 86_400_000;
const validTime = (value: unknown, at: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= at;
/** A bounded read of private-project/person journeys; reading does not create activity. */
export async function readOnboardingTimings(actor: CommunityActor, raw: unknown, now: () => number): Promise<OnboardingTimings> {
  await db.runTransaction(async tx => {
    if (!(await assertCommunityActor(tx, actor)).canAdminPlatform) throw new Refusal('forbidden', 'Only pre-approved co-founders can inspect onboarding.');
  }, { readOnly: true });
  const input = z.object({ days: z.enum(['7', '30', '90', 'all']).default('30'), projectId: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict().safeParse(raw);
  if (!input.success) throw new Refusal('bad_input', 'Choose a valid project and entry period.');
  const { days, projectId } = input.data, at = now(), since = days === 'all' ? 0 : Math.max(0, at - Number(days) * DAY);
  let query = projectJourneys.where('enteredAt', '>=', since).where('enteredAt', '<=', at).orderBy('enteredAt', 'desc').limit(LIMIT + 1);
  if (projectId) query = query.where('projectId', '==', projectId);
  const found = await query.get(), rows = found.docs.slice(0, LIMIT);
  const profileIds = [...new Set(rows.map(row => row.data().profileId))], projectIds = [...new Set(rows.map(row => row.data().projectId))];
  const [people, accounts, projectRows, cards] = await Promise.all([
    profileIds.length ? db.getAll(...profileIds.map(id => profiles.doc(id))) : [],
    profileIds.length ? db.getAll(...profileIds.map(id => onboardingProgress.doc(id))) : [],
    projectIds.length ? db.getAll(...projectIds.map(id => projects.doc(id))) : [],
    projectIds.length ? db.getAll(...projectIds.map(id => cardDoc(id))) : [],
  ]);
  const personById = new Map(people.map(p => [p.id, p.data()]));
  const accountById = new Map(accounts.map(p => [p.id, p.data()]));
  const projectById = new Map(projectRows.map(p => [p.id, p.data()]));
  const cardById = new Map(cards.map((p, index) => [projectIds[index], p.data()]));
  let removedExcluded = 0;
  const journeys = rows.flatMap(row => {
    const saved = row.data(), person = personById.get(saved.profileId), project = projectById.get(saved.projectId);
    if (person && person.removedAt !== null) { removedExcluded++; return []; }
    if (!project || !isPrivateProject(project) || project.ownerProfileId === saved.profileId) return [];
    const account = accountById.get(saved.profileId);
    const milestones: Partial<Record<OnboardingStep, number>> = {};
    const elapsed: Partial<Record<OnboardingStep, number>> = {};
    const timingEligible = saved.recordingFromEntry === true;
    for (const step of ONBOARDING_STEPS) {
      // Sign-in is journey-specific. Only computer/GitHub setup may be reused across projects.
      const value = step === 'computer' || step === 'github' ? account?.milestones[step as AccountStep] : saved.milestones[step];
      if (validTime(value, at)) {
        milestones[step] = value;
        if (timingEligible && value >= saved.enteredAt) elapsed[step] = value - saved.enteredAt;
      }
    }
    // Already-available setup is displayed as reused, never as a zero-minute fresh installation.
    for (const step of ['computer', 'github'] as const) if (saved.reused[step]) delete elapsed[step];
    const a = saved.humanActivity;
    return [{ id: row.id, profileId: saved.profileId, projectId: saved.projectId, projectTitle: cardById.get(saved.projectId)?.definition.title ?? null,
      name: person?.name ?? null, email: person?.email ?? null, enteredAt: saved.enteredAt, source: saved.source,
      timingEligible, milestones, elapsed, reused: saved.reused,
      humanActivity: { firstAt: validTime(a.firstAt, at) ? a.firstAt : null, lastAt: validTime(a.lastAt, at) ? a.lastAt : null,
        chatMessages: Number.isSafeInteger(a.chatMessages) && a.chatMessages >= 0 ? a.chatMessages : 0,
        steeringCommands: Number.isSafeInteger(a.steeringCommands) && a.steeringCommands >= 0 ? a.steeringCommands : 0 } }];
  });
  return { observedAt: at, days, projectId: projectId ?? null, total: journeys.length,
    projects: [...new Map(journeys.map(j => [j.projectId, { id: j.projectId, title: j.projectTitle }])).values()],
    scope: { limit: LIMIT, recordsChecked: rows.length, truncated: found.size > LIMIT, removedExcluded, historical: journeys.filter(j => !j.timingEligible).length }, journeys };
}
