import type { CommunicationAgent } from '@mlswarm/contracts';
import { Pause } from 'lucide-react';
import { communicationAgentState } from './communication-agent-state';

export function ProjectPauseStatus({ request, agents, now, incomplete }: {
  request: { revision: number; requestedAt: number }; agents: CommunicationAgent[]; now: number; incomplete: boolean;
}) {
  const current = agents.filter(agent => agent.projectPause?.revision === request.revision);
  const confirmed = current.filter(agent => communicationAgentState(agent, now) === 'paused').length;
  const pending = current.filter(agent => communicationAgentState(agent, now) === 'pausing').length;
  const unconfirmed = current.length - confirmed - pending;
  return <div className="k42-project-pause-status" role="status" aria-live="polite">
    <Pause size={16} aria-hidden="true" />
    <div><strong>{pending || unconfirmed || incomplete ? 'Pause requested' : current.length ? 'Agents paused' : 'Project work paused'}</strong>
      <p>{current.length ? `${confirmed} paused · ${pending} awaiting feedback · ${unconfirmed} unconfirmed.` : incomplete ? 'Pause requested. Checking agent feedback…' : 'No active agent runs require confirmation.'}
        {incomplete && ' Agent confirmations are incomplete.'}
        {!!unconfirmed && ' Unconfirmed agents may still be working. Inspect an agent for its last contact.'}</p>
      {current.some(agent => agent.projectPause?.externalChat) && <p>Agents in coding chats can’t be paused from here. Pause those chats directly.</p>}
    </div>
  </div>;
}
