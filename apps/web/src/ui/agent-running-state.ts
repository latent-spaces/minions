import { repositoryWaitMessage } from '../repository-readiness';
import type { AgentObservation, BackgroundControlInput, BackgroundControlView, RepositoryReadiness, StartWait, WorkerSteeringSession } from '@minions/contracts';

// The owner's agents grouped by who needs them, who is busy and who is idle (owner feedback, 20 October 2026).
export const AGENT_GROUPS = ['Needs you', 'Working', 'Idle', 'Paused or starting', 'Check status', 'Ended'] as const;
export type AgentGroup = typeof AGENT_GROUPS[number];
export function agentGroup(status: string, needsYou = false): AgentGroup {
  if (needsYou) return 'Needs you';
  if (status === 'Working' || status === 'Talking') return 'Working';
  if (status === 'Idle') return 'Idle';
  if (['Paused', 'Waiting', 'Backoff', 'Starting', 'Pausing'].includes(status)) return 'Paused or starting';
  return ['Stopped', 'Completed', 'Finished', 'Failed', 'Revoked'].includes(status) ? 'Ended' : 'Check status';
}
/** A stable sort into AGENT_GROUPS order; agents keep their order within a group. */
export function groupAgents<T extends { status: string; waiting?: boolean }>(agents: T[]) {
  return agents.map(agent => ({ agent, group: agentGroup(agent.status, agent.waiting) }))
    .sort((a, b) => AGENT_GROUPS.indexOf(a.group) - AGENT_GROUPS.indexOf(b.group));
}

export type AgentStatus = { label: 'Working' | 'Idle' | 'Paused' | 'Waiting' | 'Stopped' | 'Blocked' | 'Offline' | 'Recovery' | 'Stopping' | 'Pausing' | 'Pause unconfirmed' | 'Unknown'; title: string; timeLeft: number | null; pastEnd?: true };

// What an agent shows once the job's end time has passed: it is never ended, it finishes its turn and then waits.
export const PAST_END = { finishing: 'Past the end time, finishing its turn', waiting: 'Time is up. Waiting for more time' } as const;

// A worker at the job's token cap finished the turn that crossed it and waits until the owner raises or removes the cap.
export const TOKEN_CAP = 'Token cap reached. Waiting for a higher cap';
// A worker refused by its model provider for a usage or rate limit waits and tries again by itself (owner, 10 November 2026).
const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
export const providerLimitText = (s: Pick<WorkerSteeringSession, 'providerLimit'> | null | undefined) => !s?.providerLimit ? null
  : s.providerLimit.retryAt === null ? 'Provider limit reached. Trying again' : `Provider limit reached. Trying again at ${clock(s.providerLimit.retryAt)}`;
// Past the end time and at the cap: it continues only once both are lifted.
export const TIME_AND_TOKEN_CAP = 'Time is up and token cap reached. Waiting for more time and a higher cap';
type TokenSession = Pick<WorkerSteeringSession, 'tokens' | 'tokenLimit'>;
// The cap is one pool for all the person's agents in the project; othersUsed is what it counted outside this mission.
const used = (s: TokenSession) => s.tokenLimit && s.tokens ? s.tokens.counted + s.tokenLimit.othersUsed : null;
export const atTokenCap = (s: TokenSession | null | undefined) => !!s?.tokenLimit && (used(s) ?? 0) >= s.tokenLimit.tokens;
/** "Used X of Y tokens for this job", for a job with a token cap; turns with no reported usage are named, not counted as 0. */
export function tokenUsageNote(s: TokenSession | null | undefined) {
  if (!s?.tokenLimit || !s.tokens) return null;
  const n = (value: number) => value.toLocaleString('en-US');
  const unknown = s.tokens.unknownTurns ? ` ${s.tokens.unknownTurns === 1 ? '1 turn' : `${s.tokens.unknownTurns} turns`} reported no usage and ${s.tokens.unknownTurns === 1 ? 'is' : 'are'} not counted.` : '';
  return `Used ${n(used(s)!)} of ${n(s.tokenLimit.tokens)} tokens for this job.${unknown}`;
}

/** What a run that has not started yet is waiting for; also shown for a new agent queued from the website. */
export const waitingTitle = (waitingFor?: StartWait | null, repository?:RepositoryReadiness|null) => waitingFor === 'project' ? 'Waiting for the owner to start the project.'
  : waitingFor === 'time' ? 'Waiting for more time.'
  : waitingFor === 'computer' ? 'Waiting for your computer to come online with Minions running.'
  : waitingFor === 'github' ? repositoryWaitMessage(repository)
  : waitingFor === 'empty_repository' ? 'Waiting for a first commit in the project’s GitHub repository, such as a README.' : 'Starting on your computer.';
/** Only confirmed terminal observations offer Play; uncertainty and cleanup retain their own states. */
export function workerAgentStatus(agent: AgentObservation, now: number): AgentStatus {
  const b = agent.backgroundControl, s = agent.worker.session, run = agent.run;
  const result = (label: AgentStatus['label'], title: string, deadline?: number): AgentStatus => ({
    label, title, timeLeft: deadline === undefined ? null : Math.max(0, deadline - now),
  });
  const pastEnd = (working: boolean, capped = false): AgentStatus => ({ ...result(working ? 'Working' : 'Waiting', working ? PAST_END.finishing : capped ? TIME_AND_TOKEN_CAP : PAST_END.waiting), pastEnd: true });
  const fresh = (at: number) => at <= now && now - at < 90_000;
  const capped = !!s && (!b || b.missionId === s.missionId) && atTokenCap(s);
  const activity = (phase: string, deadline: number) => deadline <= now ? pastEnd(phase === 'working', phase === 'waiting' && capped) : phase === 'blocked' ? result('Blocked', 'The agent is stuck. Open it to see why.', deadline)
    : phase === 'waiting' && capped ? result('Waiting', `${TOKEN_CAP}. ${tokenUsageNote(s)} Raise the cap to continue.`, deadline)
    : phase === 'waiting' && s && (!b || b.missionId === s.missionId) && s.providerLimit ? result('Waiting', `${providerLimitText(s)}.`, deadline)
    : phase === 'waiting' ? result('Idle', 'Between turns. It wakes on new messages or a steer.', deadline) : result('Working', 'Working on its own.', deadline);
  if (b?.state === 'recovery_required' || run?.state === 'recovery_required')
    return result('Recovery', 'Needs a fix on your computer. Check the agent before starting new work.');
  if (b?.state === 'stopping') return result('Stopping', 'Stopping and confirming process cleanup.');
  if (b?.state === 'pausing') return result('Pausing', 'Finishing its current turn, then it pauses.', b.deadlineAt);
  if (run && ['pending', 'accepted', 'starting'].includes(run.state))
    return result('Waiting', waitingTitle(run.waitingFor,run.repository));
  if (b && s && b.missionId !== s.missionId)
    return result('Unknown', 'Status is out of date. Refresh before starting or controlling the agent.');
  const pause = agent.projectPause;
  if (pause && (!b || !['stopped','failed'].includes(b.state))) {
    if (pause.confirmedAt !== null && fresh(pause.confirmedAt))
      return result('Paused', 'Runtime confirmed project Pause. Resume the project to continue.', s?.deadlineAt);
    // Pause lets the turn finish (owner decision, 9 November 2026): a worker in contact and in its turn is not unconfirmed.
    const finishingTurn = s?.phase === 'working';
    if (pause.externalChat || !s || now - s.lastContactAt >= 90_000 || (!finishingTurn && now - pause.requestedAt >= 30000))
      return result('Pause unconfirmed', pause.externalChat ? 'Pause this external coding chat directly. Minions cannot interrupt its host.' : 'Project Pause requested. Runtime confirmation is unavailable.', s?.deadlineAt);
    return result('Pausing', finishingTurn ? 'Project Pause requested. Finishing its current turn, then it pauses.' : 'Project Pause requested. Waiting for runtime feedback.', s.deadlineAt);
  }
  // Both observations describe the same local mission: the computer's snapshot arrives on its owner tick, the worker's
  // session at turn end and every 20 s. For activity (working, between turns, stuck) the one asserted last wins, as on
  // the communication map: a session heard within 90 s shows the agent running even when the computer's snapshot is
  // older (owner decision, 2 November 2026). Pause, stop and recovery stay with the computer.
  if (b && s && b.missionId === s.missionId && ['running', 'waiting', 'blocked'].includes(b.state)
    && ['working', 'waiting', 'blocked'].includes(s.phase) && s.lastContactAt > b.deviceLastSeenAt && fresh(s.lastContactAt))
    return activity(s.phase, s.deadlineAt);
  if (b) {
    if (['stopped', 'failed'].includes(b.state)) return result('Stopped', b.state === 'failed' ? 'Last run failed. Inspect the failure before starting again.' : 'Stopped. Press Play to start it.');
    if (b.deviceLastSeenAt > now) return result('Unknown', 'The device observation has an unexpected timestamp.');
    if (!fresh(b.deviceLastSeenAt)) return result('Offline', 'Computer offline. Current activity is unconfirmed.', b.deadlineAt);
    switch (b.state) {
      case 'paused': return b.deadlineAt <= now ? pastEnd(false) : result('Paused', 'Paused.', b.deadlineAt);
      case 'running': case 'waiting': case 'blocked': return activity(b.state === 'running' ? 'working' : b.state, b.deadlineAt);
      case 'accepted': case 'starting': return b.deadlineAt <= now ? pastEnd(false) : result('Waiting', 'Starting on your computer.', b.deadlineAt);
      default: return result('Unknown', 'Status not confirmed yet.');
    }
  }
  if (s) {
    if (['stopped', 'completed'].includes(s.phase)) return result('Stopped', 'Not running. Press Start to run it.');
    if (s.lastContactAt > now) return result('Unknown', 'Status has an unexpected time. Refresh to check.');
    if (!fresh(s.lastContactAt)) return result('Offline', 'Not heard from recently. What it is doing now is unconfirmed.', s.deadlineAt);
    if (s.phase === 'paused') return s.deadlineAt <= now ? pastEnd(false) : result('Paused', 'Paused.', s.deadlineAt);
    if (['working', 'waiting', 'blocked'].includes(s.phase)) return activity(s.phase, s.deadlineAt);
  }
  if (run && ['failed', 'expired'].includes(run.state)) return result('Stopped', 'The last start did not complete. Inspect it before trying again.');
  return result('Unknown', 'Not running right now.');
}

// Pause lets the current turn finish, then the agent waits; Kill ends it at once (owner decision, 9 November 2026).
// The wire command for Kill is still 'stop'.
export const CONTROL_LABEL: Record<BackgroundControlInput['kind'], string> = { pause: 'Pause', resume: 'Resume', stop: 'Kill' };
export const controlLabel = (kind: BackgroundControlInput['kind']) => CONTROL_LABEL[kind];

export function backgroundControlStatus(view: BackgroundControlView, now: number, session?: AgentObservation['worker']['session']): string {
  if (view.state === 'recovery_required') return 'Needs a fix on your computer';
  // A mission also stops without a Kill (project closed, run refused by the cloud, Minions shutting down, repeated failures): only a Kill says Killing or Killed.
  const killed = view.pending?.kind === 'stop' && !['failed', 'expired'].includes(view.pending.state);
  if (view.state === 'stopping') return killed ? 'Killing' : 'Stopping';
  if (view.state === 'stopped') return killed ? 'Killed' : 'Stopped';
  if (view.state === 'failed') return 'Failed';
  if (view.state === 'pausing') return 'Pausing · finishing its turn';
  if (view.pending?.state === 'queued') return `${CONTROL_LABEL[view.pending.kind]} saved · waiting for your computer`;
  if (view.pending?.state === 'accepted') return `${view.pending.kind === 'stop' ? 'Killing' : view.pending.kind === 'pause' ? 'Pausing' : 'Resuming'} on your computer`;
  // Activity follows the same newest-observation rule as workerAgentStatus. A saved
  // running snapshot is history once both contacts age out; it is not proof of a live process.
  if (session && view.missionId === session.missionId && ['running', 'waiting', 'blocked'].includes(view.state)
    && ['working', 'waiting', 'blocked'].includes(session.phase) && session.lastContactAt > view.deviceLastSeenAt
    && session.lastContactAt <= now && now - session.lastContactAt < 90_000)
    return backgroundControlStatus({ ...view, state: session.phase === 'working' ? 'running' : session.phase as 'waiting' | 'blocked',
      deadlineAt: session.deadlineAt, deviceLastSeenAt: session.lastContactAt }, now);
  if (view.deviceLastSeenAt > now) return 'Unknown';
  if (now - view.deviceLastSeenAt >= 90_000) return 'Offline';
  if (view.deadlineAt <= now) return view.state === 'running' ? PAST_END.finishing : PAST_END.waiting;
  return ({ accepted: 'Starting', starting: 'Starting', running: 'Working', waiting: 'Idle', blocked: 'Blocked', paused: 'Paused', stopping: 'Stopping', stopped: 'Stopped', failed: 'Failed' } as Partial<Record<BackgroundControlView['state'], string>>)[view.state] ?? view.state;
}

/** Decorative animation state from the same verified observation as the sidebar label. */
export function workerAvatarState(agent: AgentObservation, now: number, needsYou = false): import('@minions/contracts').CommunicationAgentState {
  const label = workerAgentStatus(agent, now).label;
  const states: Record<AgentStatus['label'], import('@minions/contracts').CommunicationAgentState> = {
    Working:'working', Idle:'idle', Paused:'paused', Waiting:'waiting', Stopped:'stopped',
    Blocked:'blocked', Offline:'offline', Recovery:'unknown', Stopping:'pausing',
    Pausing:'pausing', 'Pause unconfirmed':'pause_unconfirmed', Unknown:'unknown',
  };
  const state = states[label];
  return needsYou && ['working','talking','idle','waiting'].includes(state) ? 'needs_you' : state;
}
