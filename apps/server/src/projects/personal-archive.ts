import { z } from 'zod';
import { collection, db, profiles, type Profile, type WithId } from '../firestore.js';
import { projects, proposals } from '../community/records.js';
import { DEFAULT_WORKSPACE_ID } from '../workspaces/schema.js';
import { membershipDoc } from './access.js';
import { Refusal } from '../errors.js';

type ArchivePreference = { archived: boolean; revision: number; updatedAt: number; requestId: string; expectedRevision: number };
export const projectArchives = (profileId: string) => collection<ArchivePreference>(`profiles/${profileId}/projectArchives`);
export const PERSONAL_ARCHIVE = z.object({ archived: z.boolean(), expected_revision: z.number().int().nonnegative(),
  client_request_id: z.string().regex(/^[\w-]{1,64}$/) }).strict();
type StarPreference = { starred: boolean; updatedAt: number };
// Starring is personal organization for the menu column (owner, 19 October 2026); it never touches the project.
export const projectStars = (profileId: string) => collection<StarPreference>(`profiles/${profileId}/projectStars`);
export const PERSONAL_STAR = z.object({ starred: z.boolean() }).strict();
export const starState = (preference: { starred?: boolean } | undefined) => ({ starred: preference?.starred === true });
export const archiveState = (preference: { archived?: boolean; revision?: number } | undefined) => ({ archived: preference?.archived === true, archiveRevision: preference?.revision ?? 0 });

// Personal organization never writes the project, membership, agent or run.
export async function setPersonalArchive(operator: WithId<Profile>, id: string, input: z.infer<typeof PERSONAL_ARCHIVE>, now: () => number) {
  return db.runTransaction(async tx => {
    const ref = projectArchives(operator.id).doc(id);
    const [person, project, proposal, member, preference] = await Promise.all([tx.get(profiles.doc(operator.id)),
      tx.get(projects.doc(id)), tx.get(proposals.doc(id)), tx.get(membershipDoc(id, operator.id)), tx.get(ref)]);
    if (!person.exists || person.data()!.removedAt !== null) throw new Refusal('unauthorized', 'Your account is no longer active.');
    const p = project.data(), draft = proposal.data(), membership = member.data();
    const accessible = p ? p.workspaceId === DEFAULT_WORKSPACE_ID && (p.ownerProfileId === operator.id
      || membership?.status === 'active' && membership.profileId === operator.id && membership.projectId === id)
      : draft?.workspaceId === DEFAULT_WORKSPACE_ID && draft.ownerProfileId === operator.id;
    if (!accessible) throw new Refusal('not_found', 'This project wasn’t found, or you’re not a member. Choose one of your projects.');
    const before = preference.data(), current = archiveState(before);
    if (before?.requestId === input.client_request_id) {
      if (before.expectedRevision !== input.expected_revision || before.archived !== input.archived)
        throw new Refusal('bad_input', 'This request ID was already used with different details. Send the original request again, or use a new request ID.');
      return { id, ...current, replayed: true };
    }
    if (current.archiveRevision !== input.expected_revision)
      throw new Refusal('proposal_conflict', 'Your project list changed. Reload it, then try again.');
    const revision = current.archiveRevision + 1;
    tx.set(ref, { archived: input.archived, revision, updatedAt: now(), requestId: input.client_request_id, expectedRevision: input.expected_revision });
    return { id, archived: input.archived, archiveRevision: revision, replayed: false };
  });
}

export async function setPersonalStar(operator: WithId<Profile>, id: string, input: z.infer<typeof PERSONAL_STAR>, now: () => number) {
  return db.runTransaction(async tx => {
    const ref = projectStars(operator.id).doc(id);
    const [person, project, proposal, member] = await Promise.all([tx.get(profiles.doc(operator.id)),
      tx.get(projects.doc(id)), tx.get(proposals.doc(id)), tx.get(membershipDoc(id, operator.id))]);
    if (!person.exists || person.data()!.removedAt !== null) throw new Refusal('unauthorized', 'Your account is no longer active.');
    const p = project.data(), draft = proposal.data(), membership = member.data();
    const accessible = p ? p.workspaceId === DEFAULT_WORKSPACE_ID && (p.ownerProfileId === operator.id
      || membership?.status === 'active' && membership.profileId === operator.id && membership.projectId === id)
      : draft?.workspaceId === DEFAULT_WORKSPACE_ID && draft.ownerProfileId === operator.id;
    if (!accessible) throw new Refusal('not_found', 'This project wasn’t found, or you’re not a member. Choose one of your projects.');
    tx.set(ref, { starred: input.starred, updatedAt: now() });
    return { id, starred: input.starred };
  });
}
