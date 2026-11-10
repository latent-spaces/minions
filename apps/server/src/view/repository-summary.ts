import type { RepositorySummary } from '@mlswarm/contracts';
import { currentProjectId, db } from '../firestore.js';
import { mergingGitHubAccess } from '../projects/github-access.js';
import { projects } from '../projects/records.js';
import { canonicalGithubRepo } from '@mlswarm/contracts';

// Reuse approved-computer, membership and repository fences from Merging. The
// website never calls GitHub or substitutes the retired cloud projection here.
export async function readRepositorySummary(repository: string, at = Date.now()): Promise<RepositorySummary> {
  const unavailable: RepositorySummary = { status: 'unavailable', repository };
  try {
    const source = await db.runTransaction(async tx => {
      const project = await tx.get(projects.doc(currentProjectId()));
      if (canonicalGithubRepo(project.data()?.setup.repoUrl) !== canonicalGithubRepo(repository)) return null;
      return (await mergingGitHubAccess(tx, currentProjectId(), repository, [], at, true)).project;
    });
    const counts = source?.pullRequests;
    if (!source || !counts?.value || counts.lastSuccessAt === null) return unavailable;
    return { status: 'observed', repository, open: counts.value.open, merged: counts.value.merged ?? null,
      lastSyncAt: counts.value.complete ? counts.lastSuccessAt : null,
      syncFailed: counts.status !== 'ok' || !source.online || at - counts.lastSuccessAt > 10 * 60_000 };
  } catch (error) {
    console.error('Project repository counts could not be read.', error);
    return unavailable;
  }
}
