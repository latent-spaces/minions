import type { ProjectLifecycle, ProjectRole, LifecycleStatus } from '@minions/contracts';

// Viewer actions follow the viewer's role; status/readiness alone never grants a permission.
export function lifecyclePresentation(state: ProjectLifecycle, role: ProjectRole) {
  const owner = role === 'owner';
  const proposal = state.kind === 'proposal';
  const proposalActions: Partial<Record<LifecycleStatus, string>> = { draft: 'Continue proposal', waiting_for_review: 'View submission', changes_requested: 'Update proposal', rejected: 'Revise proposal', withdrawn: 'View proposal', approved: 'View approval', unknown: 'View proposal' };
  const settings = !proposal && (state.status === 'setup_needed' || state.status === 'not_published' ? owner : state.status === 'paused' ? owner : state.status === 'ready_to_start' && owner && state.readiness.canStart);
  const action = proposal ? proposalActions[state.status] ?? 'View proposal' : state.status === 'setup_needed' ? owner ? 'Publish project' : 'View project' :
    state.status === 'not_published' ? owner ? 'Review and publish' : 'View project' : state.status === 'paused' ? owner ? 'Manage project' : 'Open project' :
    state.status === 'ready_to_start' && owner && state.readiness.canStart ? 'Start project' : state.status === 'active' ? 'Open project' : state.status === 'closed' ? 'View project' : state.status === 'unknown' ? 'View project' : 'Open project';
  const help = !proposal && !owner && state.status === 'setup_needed' ? 'The owner is preparing this project before recruitment begins.' :
    !proposal && !owner && state.status === 'not_published' ? 'The owner has not published this project to Explore.' : state.help;
  const visibility = proposal ? ['draft', 'withdrawn'].includes(state.admission) ? 'Only you' : 'You and reviewers' :
    state.publication === 'published' ? 'Public in Explore' : state.publication === 'unpublished' ? 'Private · Not in Explore' : 'Publication status unavailable';
  // Only the owner can start, so everyone else sees who they are waiting for.
  const label = !proposal && state.status === 'ready_to_start' && !owner ? 'Waiting for the owner to start' : state.label;
  return { label, help, action, settings, visibility };
}
