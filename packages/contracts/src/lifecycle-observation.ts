import type { ProjectExecution, ProjectLifecycleInput, LifecycleStatus, NextActor, NextAction, StartBlocker, ProjectLifecycle } from './project-lifecycle.js';

const proposalStatus = (status?: string | null): LifecycleStatus => status === 'submitted' ? 'waiting_for_review' :
  ['draft', 'changes_requested', 'rejected', 'withdrawn', 'approved'].includes(status ?? '') ? status as LifecycleStatus : 'unknown';
const copy: Record<LifecycleStatus, { label: string; help: string; actor: NextActor; action: NextAction }> = {
  draft: { label: 'Draft', help: 'You’re defining your project. Finish the proposal and submit it when ready.', actor: 'owner', action: 'submit_proposal' },
  waiting_for_review: { label: 'Waiting for review', help: 'A moderator will review your proposal. If approved, you publish it to Explore.', actor: 'reviewer', action: 'review_proposal' },
  changes_requested: { label: 'Changes requested', help: 'Read the reviewer’s feedback, revise your proposal and submit it again.', actor: 'owner', action: 'revise_proposal' },
  rejected: { label: 'Rejected', help: 'Read the reason, revise your proposal and submit it again. Previous reviews stay in its history.', actor: 'owner', action: 'revise_proposal' },
  withdrawn: { label: 'Withdrawn', help: 'This proposal is no longer in the review queue.', actor: 'owner', action: 'view_proposal' },
  approved: { label: 'Approved · Not published', help: 'Approval creates a private project in My projects. The owner publishes it to list it in Explore.', actor: 'owner', action: 'complete_setup' },
  setup_needed: { label: 'Approved · Not published', help: 'This approved project is private and absent from Explore. Publish it to list it in Explore.', actor: 'owner', action: 'complete_setup' },
  not_published: { label: 'Approved · Not published', help: 'This project is configured but not visible in Explore. Review its setup and publish when ready.', actor: 'owner', action: 'publish_project' },
  recruiting: { label: 'Open to new people', help: 'People can join now. With a start date, the project starts then, even if fewer people have joined.', actor: 'owner', action: 'recruit_contributors' },
  ready_to_start: { label: 'Ready to start', help: 'Enough people have joined. With a start date, the project starts then; the owner can start it earlier.', actor: 'owner', action: 'start_project' },
  active: { label: 'Active', help: 'Work has started. Open the project to follow its progress.', actor: 'owner', action: 'review_progress' },
  paused: { label: 'Paused', help: 'Work is paused. The owner can resume it in Settings.', actor: 'owner', action: 'resume_project' },
  closed: { label: 'Closed', help: 'This project is closed and read-only. The owner can reopen it; agents stay paused until it resumes.', actor: 'owner', action: 'reopen_project' },
  unknown: { label: 'Status unavailable', help: 'The latest project state is not available. Reload before choosing an action.', actor: 'unknown', action: 'refresh_status' },
};
const executions = new Set(['not_configured', 'ready', 'active', 'paused', 'closed']);
export function projectExecution(project: { started: boolean; paused: boolean; completedAt?: number | null; awaitingKickoff?: boolean } | undefined | null): ProjectExecution {
  return !project ? 'not_configured' : project.completedAt != null ? 'closed' : project.awaitingKickoff || !project.started ? 'ready' : project.paused ? 'paused' : 'active';
}
export function deriveProjectLifecycle(input: ProjectLifecycleInput): ProjectLifecycle {
  const proposal = input.kind === 'proposal';
  const execution = !proposal && executions.has(input.execution ?? '') ? input.execution as ProjectExecution : proposal ? 'not_configured' : 'unknown';
  const configuration = execution === 'unknown' ? 'unknown' : execution === 'not_configured' ? 'not_configured' : 'configured';
  const setup = proposal ? 'unknown' : input.setupRequired === true ? input.setupFinalizedAt ? 'finalized' : 'pending' : input.setupRequired === false ? 'not_required' : 'unknown';
  const publication = proposal ? 'unpublished' : input.listed === true ? 'published' : input.listed === false ? 'unpublished' : 'unknown';
  const minimumKnown = Number.isSafeInteger(input.minContributors) && input.minContributors! > 0;
  const countKnown = Number.isSafeInteger(input.participantCount) && input.participantCount! >= 0;
  const contributorsNeeded = minimumKnown && countKnown ? Math.max(0, input.minContributors! - input.participantCount!) : null;
  const inconsistentKickoff = execution === 'ready' && input.runtimeStarted === true;
  const status: LifecycleStatus = inconsistentKickoff ? 'unknown' : proposal ? proposalStatus(input.proposalStatus) : execution === 'closed' || execution === 'active' || execution === 'paused' ? execution :
    input.privateProject && execution === 'ready' ? 'ready_to_start' :
    configuration === 'not_configured' || setup === 'pending' ? 'setup_needed' : execution === 'unknown' || setup === 'unknown' || publication === 'unknown' ? 'unknown' :
    publication === 'unpublished' ? 'not_published' : contributorsNeeded === 0 ? 'ready_to_start' : 'recruiting';
  const blockers: StartBlocker[] = [];
  const add = (code: StartBlocker['code'], reason: string) => blockers.push({ code, reason });
  const notApplicable = execution === 'active' || execution === 'paused' || execution === 'closed';
  if (!notApplicable) {
    if (proposal) add('proposal_not_approved', 'The proposal needs approval before the project can start.');
    else {
      if (configuration === 'not_configured') add('configuration_needed', 'Add a repository and project rules first.');
      if (execution === 'unknown' || inconsistentKickoff || setup === 'unknown') add('state_unknown', 'Reload the project, then try again.');
      if (setup === 'pending') add('setup_not_finalized', 'Publish the project first.');
      // Existing legacy projects do not enforce a contributor minimum. Observe that without
      // inventing a default minimum or silently tightening their start policy.
      if (input.setupRequired === true) {
        if (contributorsNeeded === null && configuration === 'configured' && setup === 'finalized') add('minimum_unknown', 'Reload the project to see how many people have joined.');
        else if (contributorsNeeded !== null && contributorsNeeded > 0) add('minimum_not_met', `${contributorsNeeded} more ${contributorsNeeded === 1 ? 'person needs' : 'people need'} to join; the owner can start with fewer.`);
      }
    }
  }
  const authorized = input.role === 'owner';
  const ready = !notApplicable && !proposal && configuration === 'configured' && !blockers.length;
  const canStartWithFewer = input.role === 'owner' && blockers.length === 1 && blockers[0].code === 'minimum_not_met';
  const selected = copy[status];
  const help = input.privateProject && status === 'ready_to_start' ? 'Chat is open and the repository is set. The owner starts the project when agents should begin.' : status === 'recruiting' && contributorsNeeded === null ? 'People can join now. A scheduled start date still applies.' : selected.help;
  return { kind: input.kind, status, admission: proposal ? input.proposalStatus ?? 'unknown' : input.privateProject ? 'direct_private' : 'approved', configuration, setup, publication, execution,
    label: selected.label, help, next: { actor: selected.actor, action: selected.action, description: help }, contributorsNeeded,
    readiness: { state: notApplicable ? 'not_applicable' : ready ? 'ready' : blockers.some(b => b.code === 'minimum_unknown' || b.code === 'state_unknown') ? 'unknown' : 'blocked', canStart: ready && authorized, canStartWithFewer, blockers }, startsAgents: false };
}
