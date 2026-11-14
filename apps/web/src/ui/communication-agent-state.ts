import type { CommunicationAgent, CommunicationAgentState } from '@mlswarm/contracts';

export const COMMUNICATION_AGENT_LABELS: Record<CommunicationAgentState, string> = {
  working: 'Working', talking: 'Talking', idle: 'Idle', waiting: 'Waiting', needs_you: 'Needs you', blocked: 'Blocked',
  pausing: 'Pausing', pause_unconfirmed: 'Pause unconfirmed', paused: 'Paused', stopped: 'Stopped', completed: 'Finished', offline: 'Offline', revoked: 'Revoked', unknown: 'Unknown',
};
export function communicationAgentState(agent: Pick<CommunicationAgent, 'state' | 'freshUntil' | 'projectPause'> | undefined, now: number): CommunicationAgentState {
  if (!agent) return 'unknown';
  return agent.freshUntil !== null && agent.freshUntil <= now ? agent.projectPause ? 'pause_unconfirmed' : 'offline' : agent.state;
}
