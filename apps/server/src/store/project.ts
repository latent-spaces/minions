import { activeRecipientOperators, assertMembership } from '../projects/access.js';
import type { ProjectMergePolicy } from '@mlswarm/contracts';
import { collection, currentProjectId, db } from '../firestore.js';
import { Refusal } from '../errors.js';
import { readRuntime, type WorkspaceProject } from '../projects/records.js';

export async function getProject(operatorId?: string): Promise<WorkspaceProject> {
  const project = await readRuntime();
  if (!project) throw new Refusal('not_found', 'This project isn’t set up yet. Ask the owner to finish setting it up.');
  const policy = (await collection<ProjectMergePolicy>(`projects/${currentProjectId()}/mergePolicy`).doc('current').get()).data();
  if (policy?.mode === 'selected_people') {
    project.rules += '\nMerge access policy: only the project owner and selected people may merge PRs into main or the default branch. Other members may push working branches and open PRs only. Agents inherit their person’s GitHub account permissions. GitHub synchronization may still be pending; obey this policy regardless. Never push directly to main or the default branch. Review instructions still apply.';
    if (operatorId) {
      const allowed = await db.runTransaction(async tx => {
        await assertMembership(tx, operatorId);
        const operator = (await activeRecipientOperators(tx, [operatorId])).get(operatorId)!;
        return operator.role === 'owner' || policy.selected.some(row => row.profileId === operatorId && row.epoch === operator.epoch);
      });
      project.rules += allowed ? '\nYour person has merge access under this policy. GitHub checks and review instructions still apply.' : '\nYour person has PR-only access. Leave PRs ready for an authorized merger; an owner or admin must grant merge access before you merge.';
    }
  }
  return project;
}
