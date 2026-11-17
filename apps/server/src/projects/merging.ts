import { FieldPath } from '../firestore.js';
import { z } from 'zod';
import type { MergingPerson, ProjectMergingAccess } from '@minions/contracts';
import { agents, collection, db, inProject, profiles } from '../firestore.js';
import { Refusal } from '../errors.js';
import { activeRecipientOperators, assertMembership, connectionAllowed, type Membership } from './access.js';
import { projects } from './records.js';
import { mergingGitHubAccess } from './github-access.js';
import { githubUsernameOf } from './github-username.js';


const cursor = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/).optional();
export const MERGING_QUERY = z.object({ peopleCursor: cursor, agentsCursor: cursor }).strict();

/** Only sanitized GitHub observations enter this owner/admin projection; no credentials or assumed grants. */
export async function readMergingAccess(actorId: string, id: string, query: z.infer<typeof MERGING_QUERY>, now: () => number): Promise<ProjectMergingAccess> {
  return inProject(id, () => db.runTransaction(async tx => {
    const role = await assertMembership(tx, actorId);
    if (role !== 'owner') throw new Refusal('forbidden', 'Merging is available only to the project owner.');
    const project = (await tx.get(projects.doc(id))).data()!;
    let peopleQuery = collection<Membership>(`projects/${id}/members`).where('status', '==', 'active').orderBy(FieldPath.documentId()).limit(21);
    let agentQuery = agents().orderBy(FieldPath.documentId()).limit(21);
    if (query.peopleCursor) peopleQuery = peopleQuery.startAfter(query.peopleCursor);
    if (query.agentsCursor) agentQuery = agentQuery.startAfter(query.agentsCursor);
    const [members, connections] = await Promise.all([tx.get(peopleQuery), tx.get(agentQuery)]);
    const memberPage = members.docs.slice(0, 20), agentPage = connections.docs.slice(0, 20);
    const ids = new Set<string>();
    if (!query.peopleCursor) ids.add(project.ownerProfileId);
    for (const row of memberPage) {
      const value = row.data();
      if (value.profileId === row.id && value.projectId === id) ids.add(row.id);
    }
    for (const row of agentPage) ids.add(row.data().ownerProfileId);
    const eligible = await activeRecipientOperators(tx, [...ids]);
    const documents = ids.size ? await tx.getAll(...[...ids].map(personId => profiles.doc(personId))) : [];
    const peopleById = new Map<string, MergingPerson>();
    for (const row of documents) {
      const person = row.data(), membership = eligible.get(row.id);
      if (person && membership) peopleById.set(row.id, { id: row.id, name: person.name, role: membership.role, githubUsername: githubUsernameOf(person) });
    }
    const peopleIds = [...(!query.peopleCursor ? [project.ownerProfileId] : []), ...memberPage.map(row => row.id).filter(personId => personId !== project.ownerProfileId)];
    const generatedAt = now();
    const github = await mergingGitHubAccess(tx,id,project.setup.repoUrl,[...peopleById.keys()],generatedAt);
    return { projectId: id, generatedAt, repository: project.setup.repoUrl, github,
      people: peopleIds.flatMap(personId => peopleById.has(personId) ? [peopleById.get(personId)!] : []),
      peopleNext: members.size > 20 ? memberPage.at(-1)!.id : null,
      agents: agentPage.flatMap(row => {
        const value = row.data(), owner = peopleById.get(value.ownerProfileId);
        return owner ? [{ id: row.id, name: value.name, owner,
          connection: value.revokedAt !== null ? 'revoked' as const : connectionAllowed(value, eligible) ? 'current' as const : 'outdated' as const }] : [];
      }), agentsNext: connections.size > 20 ? agentPage.at(-1)!.id : null };
  }));
}
