import type { AgentObservation, BackgroundControlView, CommunicationAgentState } from '@mlswarm/contracts';
import { backgroundControlStatus, PAST_END, TIME_AND_TOKEN_CAP, TOKEN_CAP } from './agent-running-state';

/** Presentation adapter only: does not resolve runtime state or enable controls. */
export function agentIconState(label: string): CommunicationAgentState {
  const states: Record<string, CommunicationAgentState> = {
    Working: 'working', Idle: 'idle', Waiting: 'waiting', Starting: 'waiting', Queued: 'waiting', Backoff: 'waiting',
    'Needs you': 'needs_you', 'Waiting for you': 'needs_you', Blocked: 'blocked',
    Pausing: 'pausing', 'Pausing…': 'pausing', 'Pause unconfirmed': 'pause_unconfirmed', Paused: 'paused',
    Stopped: 'stopped', Stopping: 'stopped', 'Not running': 'stopped', Failed: 'stopped',
    [PAST_END.finishing]: 'working', [PAST_END.waiting]: 'waiting', [TOKEN_CAP]: 'waiting', [TIME_AND_TOKEN_CAP]: 'waiting',
    Finished: 'completed', Completed: 'completed', Offline: 'offline', Revoked: 'revoked',
  };
  return Object.hasOwn(states, label) ? states[label] : 'unknown';
}

/** The row icon uses the same contact freshness and mission activity as its text. */
export function backgroundIconState(view: BackgroundControlView, now: number, session?: AgentObservation['worker']['session']): CommunicationAgentState {
  if (view.state === 'recovery_required') return 'unknown';
  if (['stopping', 'stopped', 'failed'].includes(view.state)) return 'stopped';
  if (view.state === 'pausing' || view.pending && ['queued', 'accepted'].includes(view.pending.state)) return 'pausing';
  return agentIconState(backgroundControlStatus(view, now, session));
}
