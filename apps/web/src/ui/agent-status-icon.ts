import type { BackgroundControlView, CommunicationAgentState } from '@mlswarm/contracts';
import { PAST_END, TIME_AND_TOKEN_CAP, TOKEN_CAP } from './agent-running-state';

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

/** The icon for a background agent's row, from its state rather than its label (mirrors backgroundControlStatus). */
export function backgroundIconState(view: Pick<BackgroundControlView, 'state' | 'pending' | 'deadlineAt'>, now: number): CommunicationAgentState {
  if (view.state === 'recovery_required') return 'unknown';
  if (['stopping', 'stopped', 'failed'].includes(view.state)) return 'stopped';
  if (view.state === 'pausing' || view.pending && ['queued', 'accepted'].includes(view.pending.state)) return 'pausing';
  if (view.deadlineAt <= now) return view.state === 'running' ? 'working' : 'waiting';
  return ({ accepted: 'waiting', starting: 'waiting', running: 'working', waiting: 'idle', blocked: 'blocked', paused: 'paused' } as Partial<Record<BackgroundControlView['state'], CommunicationAgentState>>)[view.state] ?? 'unknown';
}
