import { assertProjectWritable } from './access.js';
import { z } from 'zod';
import { hashToken } from '../auth.js';
import { db, inProject, profiles, projectCollection, type Profile, type WithId } from '../firestore.js';
import { Refusal } from '../errors.js';
import { projects } from './records.js';
import { COMMUNITY_RULES, communityRulesDoc, ruleVersionId, ruleVersions, type CommunityRules } from './community-schema.js';

const RULES_EDIT = z.object({
  client_request_id: z.string().regex(/^[\w-]{1,64}$/),
  expected_version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER - 1),
  body: COMMUNITY_RULES.shape.body,
}).strict();

// Public readers receive conduct text and its version, not an author's account metadata.
export function communityRulesView(rules: CommunityRules | undefined) {
  if (!rules) throw new Refusal('bad_input', 'Something went wrong saving this. Try again in a moment; if it keeps happening, tell the Minions team.');
  return { body: rules.body, version: rules.version, updatedAt: rules.createdAt };
}

// The existing project-owner settings authority applies here. Saving neither changes
// execution nor grants moderator powers; the exact retry has one durable outcome.
export async function editCommunityRules(operator: WithId<Profile>, id: string, body: unknown, now: () => number) {
  const parsed = RULES_EDIT.safeParse(body);
  if (!parsed.success) throw new Refusal('bad_input', 'Keep the rules to 12,000 characters or fewer, and save from the latest version.');
  const input = parsed.data;
  const fingerprint = hashToken(JSON.stringify({ expected_version: input.expected_version, body: input.body }));
  return inProject(id, () => db.runTransaction(async tx => {
    const receiptRef = projectCollection<{ fingerprint: string; result: { rules: ReturnType<typeof communityRulesView>; replayed: boolean } }>('projectOperations')
      .doc(hashToken(`${operator.id}:community-rules:${input.client_request_id}`));
    const [profile, project, current, receipt] = await Promise.all([
      tx.get(profiles.doc(operator.id)), tx.get(projects.doc(id)), tx.get(communityRulesDoc(id)), tx.get(receiptRef),
    ]);
    if (!profile.exists || profile.data()!.removedAt !== null) throw new Refusal('unauthorized', 'Your account is no longer active.');
    if (!project.exists || project.data()!.ownerProfileId !== operator.id) throw new Refusal('forbidden', 'Only the owner can edit the community rules.');
    if (receipt.exists) {
      if (receipt.data()!.fingerprint !== fingerprint) throw new Refusal('bad_input', 'This request ID was already used with different details. Send the original request again, or use a new request ID.');
      return { ...receipt.data()!.result, replayed: true };
    }
    await assertProjectWritable(tx, id);
    const before = current.data();
    communityRulesView(before);
    if (before!.version !== input.expected_version) throw new Refusal('proposal_conflict', 'Someone else changed the community rules. Reload them, then save again.');
    const rules = COMMUNITY_RULES.parse({ schemaVersion: 1, version: before!.version + 1,
      body: input.body, authorProfileId: operator.id, createdAt: now() });
    tx.set(communityRulesDoc(id), rules);
    tx.create(ruleVersions(id).doc(ruleVersionId(rules.version)), rules);
    const result = { rules: communityRulesView(rules), replayed: false };
    tx.create(receiptRef, { fingerprint, result });
    return result;
  }));
}
