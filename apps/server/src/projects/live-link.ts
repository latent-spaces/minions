// The project's live link: where its agents publish what they build (a game, site or app), shown on Home.
// Owner-only, like other project settings. Saving it starts nothing and grants no powers.
import { z } from 'zod';
import { assertProjectWritable } from './access.js';
import { db, inProject, profiles, validatedCollection, type Profile, type WithId } from '../firestore.js';
import { Refusal } from '../errors.js';
import { projects } from './records.js';
import { projectSettingsPath } from './community-schema.js';

const isHttps = (value: string) => { try { return new URL(value).protocol === 'https:'; } catch { return false; } };
const LIVE_URL = z.string().max(500).refine(isHttps, 'Use an https:// link.');
const LIVE_LINK = z.object({ schemaVersion: z.literal(1), url: LIVE_URL.nullable(), updatedBy: z.string().min(1).max(200), updatedAt: z.number().int().nonnegative() }).strict();
const LIVE_EDIT = z.object({ url: z.union([LIVE_URL, z.literal('')]), expectedUrl: LIVE_URL.nullable() }).strict();
export type LiveLink = z.infer<typeof LIVE_LINK>;

export const liveLinkDoc = (id: string) => validatedCollection(`${projectSettingsPath(id)}`, value => {
  const parsed = LIVE_LINK.safeParse(value);
  if (!parsed.success) throw new Refusal('bad_input', 'The project live link has an invalid shape.');
  return parsed.data;
}).doc('live');

export const liveLinkView = (record: LiveLink | undefined) => record?.url ?? null;

export async function editLiveLink(operator: WithId<Profile>, id: string, body: unknown, now: () => number) {
  const parsed = LIVE_EDIT.safeParse(body);
  if (!parsed.success) throw new Refusal('bad_input', 'Use a full https:// link, or leave it empty to remove it.');
  const url = parsed.data.url || null;
  return inProject(id, () => db.runTransaction(async tx => {
    const [profile, project] = await Promise.all([tx.get(profiles.doc(operator.id)), tx.get(projects.doc(id))]);
    if (!profile.exists || profile.data()!.removedAt !== null) throw new Refusal('unauthorized', 'Your account is no longer active.');
    if (!project.exists || project.data()!.ownerProfileId !== operator.id) throw new Refusal('forbidden', 'Only the project owner sets the live link.');
    await assertProjectWritable(tx, id);
    const current = (await tx.get(liveLinkDoc(id))).data()?.url ?? null;
    // Absolute updates replay safely after a lost reply, while a different later
    // save cannot be overwritten by a stale tab or delayed retry.
    if (current === url) return { liveUrl: url };
    if (current !== parsed.data.expectedUrl) throw new Refusal('proposal_conflict', 'The live link changed. Reload Settings before saving a different link.');
    tx.set(liveLinkDoc(id), LIVE_LINK.parse({ schemaVersion: 1, url, updatedBy: operator.id, updatedAt: now() }));
    return { liveUrl: url };
  }));
}
