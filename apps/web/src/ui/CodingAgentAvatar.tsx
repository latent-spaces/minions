import type { ComponentProps, CSSProperties } from 'react';
import { AgentAvatar } from './AgentAvatar';
import { codingAgent } from './coding-agent';
import './coding-agent-avatar.css';

/** Opt-in tool identity for cards, detail headers and expanded own-agent shortcuts. */
export function CodingAgentAvatar({ provider, ...props }: ComponentProps<typeof AgentAvatar> & { provider?: string | null }) {
  const agent = codingAgent(provider);
  const style = { '--k42-tool-badge-size': `${Math.max(14, Math.min(24, Math.round((props.size ?? 32) * .35)))}px` } as CSSProperties;
  return <span className="k42-coding-agent-avatar" style={style}>
    <AgentAvatar {...props} />
    {agent && <span className="k42-tool-badge" role="img" aria-label={`Coding agent: ${agent.name}`} tabIndex={0}>
      <span className={`k42-tool-glyph is-${agent.id}`} aria-hidden="true" />
      <span className="k42-tool-tooltip" aria-hidden="true">{agent.name}</span>
    </span>}
  </span>;
}

export function CodingAgentLabel({ provider }: { provider?: string | null }) {
  const agent = codingAgent(provider);
  return agent ? <span className="k42-tool-label"><span className={`k42-tool-glyph is-${agent.id}`} aria-hidden="true" />{agent.name}</span> : <>Unknown</>;
}
