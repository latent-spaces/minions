import { lifecyclePresentation } from './lifecycle-presentation.js';
import { deriveProjectLifecycle, type ProjectLifecycle, type ProjectLifecycleInput } from '@mlswarm/contracts';

type PersonalProjectState = ProjectLifecycleInput & { proposalStatus: string | null; state?: ProjectLifecycle; lifecycle?: string };

// Presentation consumes the API's derived observation. The same pure calculation supports
// the already-published beta.9 responses until the matching API and website are deployed.
export function personalProjectLifecycle(project: PersonalProjectState): ProjectLifecycle {
  return project.state ?? deriveProjectLifecycle({ ...project,
    setupRequired: project.setupRequired ?? project.lifecycle === 'setup',
    setupFinalizedAt: project.setupFinalizedAt ?? null });
}
export function personalProjectStatus(project: PersonalProjectState) {
  return lifecyclePresentation(personalProjectLifecycle(project), project.role);
}
export function workspaceProjectStatus(workspace: { role: ProjectLifecycleInput['role']; state?: ProjectLifecycle; listed?: boolean; execution: string; participantCount?: number; setup?: { required: boolean; finalizedAt: number | null; minContributors: number | null } }) {
  return personalProjectStatus({ kind: 'project', proposalStatus: null, state: workspace.state, role: workspace.role, listed: workspace.listed, execution: workspace.execution,
    participantCount: workspace.participantCount, minContributors: workspace.setup?.minContributors,
    setupRequired: workspace.setup?.required ?? false, setupFinalizedAt: workspace.setup?.finalizedAt ?? null });
}
