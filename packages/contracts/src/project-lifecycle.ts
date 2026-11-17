// Pure observation shared by the API and browser. This never authorizes a mutation.
export type ProjectRole = 'owner' | 'member' | 'guest';
export type ProjectExecution = 'not_configured' | 'ready' | 'active' | 'paused' | 'closed';
export type ProjectLifecycleInput = {
  kind: 'project' | 'proposal'; proposalStatus?: string | null; role: ProjectRole;
  execution?: string; runtimeStarted?: boolean; listed?: boolean; privateProject?: boolean; setupRequired?: boolean; setupFinalizedAt?: number | null;
  participantCount?: number | null; minContributors?: number | null;
};
export type LifecycleStatus = 'draft' | 'waiting_for_review' | 'changes_requested' | 'rejected' | 'withdrawn' | 'approved' |
  'setup_needed' | 'not_published' | 'recruiting' | 'ready_to_start' | 'active' | 'paused' | 'closed' | 'unknown';
export type NextActor = 'owner' | 'reviewer' | 'none' | 'unknown';
export type NextAction = 'submit_proposal' | 'review_proposal' | 'revise_proposal' | 'view_proposal' | 'complete_setup' |
  'publish_project' | 'recruit_contributors' | 'start_project' | 'review_progress' | 'resume_project' | 'review_results' | 'reopen_project' | 'refresh_status';
export type StartBlocker = { code: 'proposal_not_approved' | 'configuration_needed' | 'setup_not_finalized' | 'minimum_not_met' | 'minimum_unknown' | 'state_unknown'; reason: string };
export type ProjectLifecycle = {
  kind: 'project' | 'proposal'; status: LifecycleStatus; admission: string; configuration: 'configured' | 'not_configured' | 'unknown';
  setup: 'pending' | 'finalized' | 'not_required' | 'unknown'; publication: 'published' | 'unpublished' | 'unknown';
  execution: ProjectExecution | 'unknown'; label: string; help: string;
  next: { actor: NextActor; action: NextAction; description: string };
  contributorsNeeded: number | null;
  readiness: { state: 'ready' | 'blocked' | 'unknown' | 'not_applicable'; canStart: boolean; canStartWithFewer: boolean; blockers: StartBlocker[] };
  // Project kickoff, including scheduled kickoff, never launches native workers.
  startsAgents: false;
};
