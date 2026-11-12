import { CodingAgentAvatar } from './CodingAgentAvatar';
import type { PersonaChoice } from '@mlswarm/contracts';
import type { ReactNode } from 'react';
import './agents.css';

export interface AgentCardProps {
  state?: import('@mlswarm/contracts').CommunicationAgentState;
  provider?: string | null;
  persona?: PersonaChoice | null;
  agentId?: string;
  ownerId?: string | null;
  headingLevel?: 2 | 3;
  name: string;
  identity: string;
  operator: ReactNode;
  mine?: boolean;
  revoked?: boolean;
  phase: ReactNode;
  focus?: ReactNode;
  model: ReactNode;
  contact: ReactNode;
  input: ReactNode;
  output: ReactNode;
  viewAgent: ReactNode;
}

/** The same card used in the real directory and the design preview. Data comes from its caller. */
export function AgentCard({ headingLevel = 3, provider, state, persona, agentId, ownerId, name, identity, operator, mine, revoked, phase, focus, model, contact, input, output, viewAgent }: AgentCardProps) {
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  return <article className="k42-agent-card" aria-label={name}>
    <div className="k42-agent-header">
      <CodingAgentAvatar provider={provider} state={state} name={identity} id={agentId ?? identity} ownerId={ownerId} persona={persona} size={68} decorative />
      <div className="k42-agent-identity"><Heading>{name}</Heading><p>{operator}</p>{phase}</div>
      {(mine || revoked) && <div className="k42-agent-marks">{mine && <span className="k42-my-agent">My agent</span>}{revoked && <span className="k42-revoked">Revoked</span>}</div>}
    </div>
    {focus}
    <dl className="k42-agent-model"><div><dt>Reported model</dt><dd>{model}</dd></div></dl>
    <dl className="k42-agent-stats"><div><dt>Last contact</dt><dd>{contact}</dd></div><div><dt>Input (not cached)</dt><dd>{input}</dd></div><div><dt>Output tokens</dt><dd>{output}</dd></div></dl>
    <div className="k42-agent-footer">{viewAgent}</div>
  </article>;
}
