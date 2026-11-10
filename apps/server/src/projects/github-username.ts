import { mergePolicySnapshot } from './merge-policy.js';
import type { MergePolicyTarget } from '@mlswarm/contracts';
import { canonicalGithubRepo, type GitHubAccessTarget } from '@mlswarm/contracts';
import { z } from 'zod';
import { collection, db, inProject, profiles, type Profile } from '../firestore.js';
import { membershipsOf, activeRecipientOperators, type Membership } from './access.js';
import { projects } from './records.js';

// A person's GitHub username, from their GitHub sign-in.
export const GITHUB_USERNAME = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/, 'Use a GitHub username.');
export const githubUsernameOf = (person: Profile | undefined) => person?.githubUsername ?? null;

// The repositories of the person's open projects, for their computer to bring access up to date (owner decision,
// 22 October 2026): the active members' usernames of each one they own, and each one they joined.
export async function repositoryAccess(personId: string) {
  const repoOf = (project?: { setup: { repoUrl: string | null }; execution: { completedAt: number | null } }) => project?.execution.completedAt === null ? project.setup.repoUrl : null;
  const observations: GitHubAccessTarget[] = [];
  const mergePolicies: MergePolicyTarget[] = [];
  const owned: { repo: string; usernames: string[] }[] = [], joined: string[] = [];
  // Closed history must not consume the bounded page of repositories that still need synchronization.
  for (const row of (await projects.where('ownerProfileId', '==', personId).where('execution.completedAt', '==', null).limit(50).get()).docs) {
    // Discovery is not mutation authority: recheck ownership/closure in the same
    // snapshot used to issue an operational merge-policy target.
    const current = await inProject(row.id, () => db.runTransaction(async tx => {
      const project = (await tx.get(projects.doc(row.id))).data();
      if (!project || project.ownerProfileId !== personId || project.execution.completedAt !== null) return null;
      return { repo: repoOf(project), merge: await mergePolicySnapshot(tx, row.id) };
    }));
    const repo = current?.repo;
    if (!repo) continue;
    if (current.merge.target) mergePolicies.push(current.merge.target);
    const members = await inProject(row.id, () => collection<Membership>(`projects/${row.id}/members`).where('status', '==', 'active').limit(100).get());
    const ids = members.docs.map(doc => doc.id).filter(id => id !== personId);
    const people = ids.length ? await db.getAll(...ids.map(id => profiles.doc(id))) : [];
    const repository=canonicalGithubRepo(repo);
    if(repository) observations.push({projectId:row.id,repository,scope:'project',membershipEpoch:0});
    owned.push({ repo, usernames: people.map(doc => doc.data()?.removedAt === null ? githubUsernameOf(doc.data() as Profile) : null).filter((name): name is string => name !== null) });
  }
  for (const row of (await membershipsOf(personId).where('status', '==', 'active').limit(50).get()).docs) {
    const project = (await projects.doc(row.id).get()).data(), repo = repoOf(project);
    if (repo && project!.ownerProfileId !== personId) {
      const repository=canonicalGithubRepo(repo), member=row.data();
      if(repository && member.profileId===personId && member.projectId===row.id) {
        const operator=await inProject(row.id,()=>db.runTransaction(async tx=>(await activeRecipientOperators(tx,[personId])).get(personId)));
        // The discovery mirror may predate a removal. Action targets need the same current authority as reports.
        if(operator) {
          joined.push(repo);
          observations.push({projectId:row.id,repository,scope:'self',membershipEpoch:operator.epoch});
        }
      }
    }
  }
  return { owned, joined, observations, mergePolicies };
}
