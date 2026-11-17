import { z } from 'zod';
import { collection, db, profiles } from '../firestore.js';
import { Refusal } from '../errors.js';
import { assertCommunityActor, type CommunityActor } from '../community/identity.js';

type PlatformSettings = { revision: number; maxContributors: number | null; maxPrivateParticipants?: number; maxAgentsPerParticipant?: number; reviewerEmails: string[]; updatedAt: number | null; updatedBy: string | null };
// Provisional first-release default; co-founders can choose a different ceiling.
export const privateParticipantLimit = (settings: PlatformSettings | undefined) => settings?.maxPrivateParticipants ?? 10;
// Agents one person may own in one project (owner choice, 20 Oct 2026: default 20, co-founders set 1–200).
// Lowering it blocks new agents and never revokes existing ones, so roster reads use the ceiling.
export const AGENTS_PER_PARTICIPANT_CEILING = 200;
export const agentsPerParticipantLimit = (settings: PlatformSettings | undefined) => settings?.maxAgentsPerParticipant ?? 20;
export const platformSettings = collection<PlatformSettings>('platformSettings').doc('limits');
export const emptySettings: PlatformSettings = { revision: 0, maxContributors: null, reviewerEmails: [], updatedAt: null, updatedBy: null };
export const PLATFORM_UPDATE = z.object({ expected_revision: z.number().int().nonnegative(),
  max_contributors: z.number().int().min(1).max(10000).nullable(),
  reviewer_emails: z.array(z.email().trim().toLowerCase().max(254)).max(50),
  max_private_participants: z.number().int().min(1).max(10000).optional(),
  max_agents_per_participant: z.number().int().min(1).max(AGENTS_PER_PARTICIPANT_CEILING).optional(),
}).strict().refine(value => new Set(value.reviewer_emails).size === value.reviewer_emails.length, { message: 'Use each reviewer email once.' });
export async function readPlatformSettings(actor: CommunityActor) {
  return db.runTransaction(async tx => {
    const { canAdminPlatform } = await assertCommunityActor(tx, actor);
    if (!canAdminPlatform) throw new Refusal('forbidden', 'Only pre-approved co-founders can manage platform settings.');
    const settings = (await tx.get(platformSettings)).data() ?? emptySettings;
    return { ...settings, maxPrivateParticipants: privateParticipantLimit(settings), maxAgentsPerParticipant: agentsPerParticipantLimit(settings) };
  });
}
export async function updatePlatformSettings(actor: CommunityActor, input: z.infer<typeof PLATFORM_UPDATE>, now: () => number) {
  return db.runTransaction(async tx => {
    const { canAdminPlatform, operator } = await assertCommunityActor(tx, actor);
    if (!canAdminPlatform) throw new Refusal('forbidden', 'Only pre-approved co-founders can manage platform settings.');
    const current = (await tx.get(platformSettings)).data() ?? emptySettings;
    // Retrying this exact write after a lost response is safe; a different later revision conflicts.
    if (current.revision === input.expected_revision + 1 && current.updatedBy === operator.id
      && current.maxContributors === input.max_contributors && (input.max_private_participants === undefined || privateParticipantLimit(current) === input.max_private_participants)
      && (input.max_agents_per_participant === undefined || agentsPerParticipantLimit(current) === input.max_agents_per_participant)
      && JSON.stringify(current.reviewerEmails) === JSON.stringify(input.reviewer_emails)) return current;
    if (current.revision !== input.expected_revision) throw new Refusal('proposal_conflict', 'Platform settings changed. Reload before saving.');
    const invitations = await Promise.all(input.reviewer_emails.map(email => tx.get(profiles.where('email', '==', email).where('removedAt', '==', null).limit(2))));
    if (invitations.some(found => found.size !== 1)) throw new Refusal('bad_input', 'Every reviewer needs exactly one active community invitation.');
    const settings = { revision: current.revision + 1, maxContributors: input.max_contributors, maxPrivateParticipants: input.max_private_participants ?? privateParticipantLimit(current),
      maxAgentsPerParticipant: input.max_agents_per_participant ?? agentsPerParticipantLimit(current),
      reviewerEmails: input.reviewer_emails, updatedAt: now(), updatedBy: operator.id };
    tx.set(platformSettings, settings);
    tx.create(collection('platformSettingsHistory').doc(String(settings.revision)), { ...settings, previous: current });
    return settings;
  });
}
