import type { ComponentProps, CSSProperties } from 'react';
import type { CommunicationAgentState } from '@mlswarm/contracts';
import { AgentAvatar } from './AgentAvatar';
import { AgentStatusIcon } from './AgentStatusIcon';
import { codingAgent } from './coding-agent';
import './coding-agent-avatar.css';

/** An agent's face with its coding tool on the bottom-right corner and, when given, its state on the top-right. */
export function CodingAgentAvatar({ provider, status, ...props }: ComponentProps<typeof AgentAvatar> & { provider?: string | null; status?: { state?: CommunicationAgentState; label?: string } }) {
  const agent = codingAgent(provider);
  const style = { '--k42-tool-badge-size': `${Math.max(14, Math.min(24, Math.round((props.size ?? 32) * .35)))}px` } as CSSProperties;
  return <span className="k42-coding-agent-avatar" style={style}>
    <AgentAvatar {...props} provider={provider} state={status?.state ?? props.state} />
    {agent && <span className="k42-tool-badge" role="img" aria-label={`Coding agent: ${agent.name}`} tabIndex={0}>
      <span className={`k42-tool-glyph is-${agent.id}`} aria-hidden="true" />
      <span className="k42-tool-tooltip" aria-hidden="true">{agent.name}</span>
    </span>}
    {status && <AgentStatusIcon {...status} overlay />}
  </span>;
}

export function CodingAgentLabel({ provider }: { provider?: string | null }) {
  const agent = codingAgent(provider);
  return agent ? <span className="k42-tool-label"><span className={`k42-tool-glyph is-${agent.id}`} aria-hidden="true" />{agent.name}</span> : <>Unknown</>;
}
