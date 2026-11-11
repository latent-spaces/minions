import { AgentStatusIcon } from './AgentStatusIcon';
import type { ReactNode } from 'react';
import type { AgentObservation, ProjectWorkersView } from '@mlswarm/contracts';
import { workerAgentStatus, waitingTitle, type AgentStatus } from './agent-running-state';
import { timeLeft } from '../observation-time';
import { AgentFocus } from './AgentFocus';
import './agent-observation-list.css';

// Fetching and controls belong to the caller. The hosted adapter supplies action and navigation slots.
export function AgentObservationList<T extends AgentObservation>({ agents, queued, now, name, details, actions }: {
  agents: T[]; queued: ProjectWorkersView['queued']; now: number;
  name?: (agent: T) => ReactNode; details?: (agent: T, status: AgentStatus) => ReactNode; actions?: (agent: T) => ReactNode;
}) {
  return <ul className="list agent-rows agent-observation-list">{queued.map(start => <li key={`queued:${start.id}`} className="my-agent">
    <div><strong>{start.name}</strong><p className="muted"><span className="k42-agent-status-text"><AgentStatusIcon state="waiting" decorative />Waiting</span> · {waitingTitle(start.waitingFor)}</p><p className="muted">No focus reported yet.</p></div>
  </li>)}{agents.map(agent => {
    const status = workerAgentStatus(agent, now);
    const allowance = status.timeLeft !== null ? timeLeft(status.timeLeft) : null;
    return <li key={`agent:${agent.agentId}`} className="my-agent">
      <div className="agent-observation-body"><div className="agent-observation-heading">{name ? name(agent) : <strong>{agent.agentName}</strong>}
        <span className="agent-observation-status k42-agent-status-text"><AgentStatusIcon label={status.label} decorative />{status.label}</span>{allowance && <span className="muted agent-observation-time">{allowance}</span>}</div>
        {agent.focus ? <AgentFocus focus={agent.focus} now={now} /> : <p className="muted">No focus reported yet.</p>}
        {(status.pastEnd || ['Waiting', 'Offline', 'Unknown', 'Recovery', 'Blocked', 'Stopping', 'Pausing', 'Pause unconfirmed'].includes(status.label)) && <p className="muted">{status.title}</p>}
        {details?.(agent, status)}
      </div>{actions?.(agent)}
    </li>;
  })}</ul>;
}
