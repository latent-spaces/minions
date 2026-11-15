import type { Transaction } from '../firestore.js';
import { z } from 'zod';
import type { ProjectMergePolicy, MergePolicyTarget, MergePolicyView, MergePolicyCode } from '@mlswarm/contracts';
import { collection, db, githubAccounts, inProject, profiles } from '../firestore.js';
import { hashToken } from '../auth.js';
import { Refusal } from '../errors.js';
import { activeRecipientOperators, assertMembership, assertProjectWritable, type Membership } from './access.js';
import { projects } from './records.js';
import { canonicalGithubRepo } from '@mlswarm/contracts';

const profileId = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const policySchema = z.object({ revision: z.number().int().nonnegative(), mode: z.enum(['existing', 'selected_people']), selected: z.array(z.object({ profileId, epoch: z.number().int().nonnegative() }).strict()).max(100) }).strict();
export const mergePolicyDoc = (id: string) => collection<ProjectMergePolicy>(`projects/${id}/mergePolicy`).doc('current');
const defaultPolicy = (): ProjectMergePolicy => ({ revision: 0, mode: 'existing', selected: [] });
const reports = (id: string) => collection<{ policyKey: string; code: MergePolicyCode; checkedAt: number; profileId: string }>(`projects/${id}/mergePolicyReports`);
export const MERGE_POLICY_EDIT = z.object({ client_request_id: z.string().regex(/^[\w-]{1,64}$/), expected_revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1), mode: z.enum(['existing', 'selected_people']), selected_profile_ids: z.array(profileId).max(100) }).strict();

// Numeric account IDs come from verified sign-ins, never a current lookup of a reusable username.
async function githubId(tx: Transaction, id: string): Promise<number | null> {
  const person = (await tx.get(profiles.doc(id))).data();
  if (!person || person.removedAt !== null || !person.githubUsername) return null;
  const accounts = await tx.get(githubAccounts.where('login', '==', person.githubUsername).limit(2));
  const valid = accounts.docs.filter(row => row.data().emails.includes(person.email.toLowerCase()) && /^[1-9][0-9]*$/.test(row.id) && Number.isSafeInteger(Number(row.id)));
  return valid.length === 1 ? Number(valid[0].id) : null;
}

export async function mergePolicySnapshot(tx: Transaction, id: string): Promise<{ policy: ProjectMergePolicy; target: MergePolicyTarget | null; problem: 'identity_required' | 'too_many_members' | null }> {
  const [saved, project] = await Promise.all([tx.get(mergePolicyDoc(id)), tx.get(projects.doc(id))]);
  const policy = saved.exists ? policySchema.parse(saved.data()) : defaultPolicy();
  const record = project.data()!, repository = canonicalGithubRepo(record.setup.repoUrl);
  if (!repository || policy.revision === 0) return { policy, target: null, problem: null };
  const members = await tx.get(collection<Membership>(`projects/${id}/members`).where('status', '==', 'active').limit(1001));
  if (members.size > 1000) return { policy, target: null, problem: 'too_many_members' };
  const operators = await activeRecipientOperators(tx, [record.ownerProfileId, ...members.docs.map(row => row.id)]);
  const allowed = [...operators].filter(([personId, operator]) => operator.role === 'owner' || policy.selected.some(person => person.profileId === personId && person.epoch === operator.epoch));
  const ownerGithubId = await githubId(tx, record.ownerProfileId);
  const ids = policy.mode === 'selected_people' ? await Promise.all(allowed.map(([personId]) => githubId(tx, personId))) : [];
  if (!ownerGithubId) return { policy, target: null, problem: 'identity_required' };
  const allowedGithubIds = [...new Set(ids.filter((value): value is number => value !== null))].sort((a, b) => a - b);
  // Roles, removals, rejoining and sign-in changes invalidate earlier receipts without needing a policy edit.
  const policyKey = hashToken(JSON.stringify([id, repository, policy, ownerGithubId, allowedGithubIds]));
  return { policy, target: { projectId: id, repository, policyKey, mode: policy.mode, ownerGithubId, allowedGithubIds }, problem: ids.includes(null) ? 'identity_required' : null };
}

export async function mergePolicyView(tx: Transaction, id: string, at: number): Promise<MergePolicyView> {
  const { policy, target, problem } = await mergePolicySnapshot(tx, id);
  if (policy.revision === 0) return { policy, enforcement: { state: 'not_enabled', checkedAt: null, code: null } };
  const saved = await tx.get(reports(id).orderBy('checkedAt', 'desc').limit(10));
  const record = (await tx.get(projects.doc(id))).data()!;
  const latest = saved.docs.map(row => row.data()).find(row => row.profileId === record.ownerProfileId && row.policyKey === target?.policyKey);
  const operators = await activeRecipientOperators(tx, policy.selected.map(row => row.profileId));
  const visiblePolicy = { ...policy, selected: policy.selected.filter(row => operators.get(row.profileId)?.epoch === row.epoch) };
  const state = problem ? 'pending' : !latest ? 'pending' : at - latest.checkedAt > 120000 ? 'stale' : latest.code === 'verified' ? 'verified' : latest.code === 'removed' ? 'not_enabled' : 'failed';
  return { policy: visiblePolicy, enforcement: { state, checkedAt: latest?.checkedAt ?? null, code: problem ?? latest?.code ?? null } };
}

export async function editMergePolicy(actorId: string, id: string, body: unknown, now: () => number = Date.now) {
  const parsed = MERGE_POLICY_EDIT.safeParse(body);
  if (!parsed.success) throw new Refusal('bad_input', 'Use the current merge-access revision and a list of project members.');
  const input = parsed.data;
  if (new Set(input.selected_profile_ids).size !== input.selected_profile_ids.length || input.mode === 'existing' && input.selected_profile_ids.length) throw new Refusal('bad_input', 'Use each selected person once; clear the selection when turning this mode off.');
  return inProject(id, () => db.runTransaction(async tx => {
    const role = await assertMembership(tx, actorId);
    if (role !== 'owner') throw new Refusal('forbidden', 'Only the project owner can grant merge access.');
    const receiptRef = collection<{ fingerprint: string; revision: number }>(`projects/${id}/projectOperations`).doc(hashToken(`${actorId}:merge-policy:${input.client_request_id}`));
    const [receipt, saved] = await Promise.all([tx.get(receiptRef), tx.get(mergePolicyDoc(id))]);
    const fingerprint = hashToken(JSON.stringify(input));
    if (receipt.exists) {
      if (receipt.data()!.fingerprint !== fingerprint) throw new Refusal('bad_input', 'This request ID was already used with different details.');
      return { revision: receipt.data()!.revision, replayed: true };
    }
    await assertProjectWritable(tx, id);
    const previous = saved.exists ? policySchema.parse(saved.data()) : defaultPolicy();
    if (previous.revision !== input.expected_revision) throw new Refusal('proposal_conflict', 'Merge access changed. Reload before editing again.');
    const operators = await activeRecipientOperators(tx, input.selected_profile_ids);
    for (const personId of input.selected_profile_ids) if (!operators.has(personId)) throw new Refusal('bad_input', 'Merge access can be granted only to current project members.');
    const selected = input.selected_profile_ids.filter(personId => operators.get(personId)!.role !== 'owner').sort().map(personId => ({ profileId: personId, epoch: operators.get(personId)!.epoch }));
    const revision = previous.revision + 1;
    const value: ProjectMergePolicy = { revision, mode: input.mode, selected };
    tx.create(collection(`projects/${id}/mergePolicyHistory`).doc(String(revision).padStart(16, '0')), { ...value, editorProfileId: actorId, at: now() });
    tx.set(mergePolicyDoc(id), value);
    tx.create(receiptRef, { fingerprint, revision });
    return { revision, replayed: false };
  }));
}

const REPORT = z.object({ projectId: z.string().regex(/^[a-f0-9]{64}$/), policyKey: z.string().regex(/^[a-f0-9]{64}$/), code: z.enum(['verified', 'removed', 'github_permissions', 'github_unavailable', 'account_mismatch', 'verification_failed', 'conflicting_rulesets', 'empty_repository']) }).strict();
export async function reportMergePolicy(actorId: string, body: unknown, now: () => number) {
  const parsed = REPORT.safeParse(body);
  if (!parsed.success) throw new Refusal('bad_input', 'Invalid merge enforcement report.');
  const input = parsed.data;
  return inProject(input.projectId, () => db.runTransaction(async tx => {
    await assertMembership(tx, actorId);
    const project = await tx.get(projects.doc(input.projectId));
    const at = now();
    if (project.data()!.ownerProfileId !== actorId) throw new Refusal('forbidden', 'Only the project owner can report enforcement.');
    const snapshot = await mergePolicySnapshot(tx, input.projectId);
    if (!snapshot.target || snapshot.target.policyKey !== input.policyKey) throw new Refusal('proposal_conflict', 'Merge access changed. Synchronize the current policy.');
    if (input.code === 'verified' && snapshot.policy.mode !== 'selected_people' || input.code === 'removed' && snapshot.policy.mode !== 'existing') throw new Refusal('bad_input', 'Report does not match the selected mode.');
    tx.set(reports(input.projectId).doc(actorId), { policyKey: input.policyKey, code: input.code, checkedAt: at, profileId: actorId });
    return { ok: true };
  }));
}

/** Project members can see merge policy and synchronization, without operational GitHub targets. */
export async function readMergePolicy(actorId: string, id: string, now: () => number): Promise<MergePolicyView> {
  return inProject(id, () => db.runTransaction(async tx => {
    await assertMembership(tx, actorId);
    return mergePolicyView(tx, id, now());
  }, { readOnly: true }));
}
