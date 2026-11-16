// Storage foundations only. These records grant no moderation or role-management powers.
import type { Transaction } from '../firestore.js';
import { z } from 'zod';
import { validatedCollection } from '../firestore.js';
import { Refusal } from '../errors.js';

const profileId = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER - 1);

const COMMUNITY_SETTINGS = z.object({
  schemaVersion: z.literal(1), revision,
  chatRead: z.enum(['members', 'public']), chatSend: z.literal('members'),
  joining: z.literal('invited_users'), updatedAt: time, updatedByProfileId: profileId,
}).strict();
type CommunitySettings = z.infer<typeof COMMUNITY_SETTINGS>;

// Community conduct rules are separate from the agent's derived Outcome/Scope/Acceptance text.
export const COMMUNITY_RULES = z.object({
  schemaVersion: z.literal(1), version: revision,
  body: z.string().max(12000), authorProfileId: profileId, createdAt: time,
}).strict();
export type CommunityRules = z.infer<typeof COMMUNITY_RULES>;

function projectPath(id: string) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Refusal('bad_input', 'Choose a valid project ID.');
  return `projects/${id}`;
}
function decodeRecord<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Refusal('bad_input', 'Something went wrong saving this. Try again in a moment; if it keeps happening, tell the Minions team.');
  return parsed.data;
}
const decodeCommunitySettings = (value: unknown): CommunitySettings => decodeRecord(COMMUNITY_SETTINGS, value);
export const projectSettingsPath = (id: string) => `${projectPath(id)}/settings`;
export const communitySettingsDoc = (id: string) => validatedCollection(`${projectPath(id)}/settings`, decodeCommunitySettings).doc('community');
export const communityRulesDoc = (id: string) => validatedCollection(`${projectPath(id)}/rules`, value => decodeRecord(COMMUNITY_RULES, value)).doc('current');
export const ruleVersions = (id: string) => validatedCollection(`${projectPath(id)}/ruleVersions`, value => decodeRecord(COMMUNITY_RULES, value));
export const ruleVersionId = (version: number) => String(revision.parse(version)).padStart(16, '0');

const newCommunitySettings = (ownerProfileId: string, at: number): CommunitySettings =>
  COMMUNITY_SETTINGS.parse({ schemaVersion: 1, revision: 1, chatRead: 'members', chatSend: 'members',
    joining: 'invited_users', updatedAt: at, updatedByProfileId: ownerProfileId });
const newCommunityRules = (ownerProfileId: string, at: number): CommunityRules =>
  COMMUNITY_RULES.parse({ schemaVersion: 1, version: 1, body: '', authorProfileId: ownerProfileId, createdAt: at });
export function communityDefaults(ownerProfileId: string, at: number): { settings: CommunitySettings; rules: CommunityRules } {
  return { settings: newCommunitySettings(ownerProfileId, at), rules: newCommunityRules(ownerProfileId, at) };
}
export function createCommunityDefaults(tx: Transaction, id: string, ownerProfileId: string, at: number) {
  const defaults = communityDefaults(ownerProfileId, at);
  tx.create(communitySettingsDoc(id), defaults.settings);
  tx.create(communityRulesDoc(id), defaults.rules);
  tx.create(ruleVersions(id).doc(ruleVersionId(1)), defaults.rules);
  return defaults;
}

// The caller reads settings alongside its other authority records before any transaction writes.
// This helper does no reads. Publishing preserves the currently selected public-chat behavior.
export function setCommunityPublication(tx: Transaction, id: string, listed: boolean, at: number,
  currentSettings: CommunitySettings, actorProfileId: string): CommunitySettings {
  const current = decodeCommunitySettings(currentSettings), chatRead = listed ? 'public' : 'members';
  if (current.chatRead === chatRead) return current;
  const updated = COMMUNITY_SETTINGS.parse({ ...current, revision: current.revision + 1, chatRead,
    updatedAt: at, updatedByProfileId: actorProfileId });
  tx.set(communitySettingsDoc(id), updated);
  return updated;
}
