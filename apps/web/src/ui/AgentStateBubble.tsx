import { AgentStateSymbol } from './AgentStatusIcon';
import type { CommunicationAgentState } from '@minions/contracts';
import './agent-state-bubble.css';

/** State is supplied by the host; this presentation never infers work from traffic. */
export function AgentStateBubble({ state }: { state: CommunicationAgentState }) {
  const urgent = state === 'needs_you';
  return <g className={`agent-state-bubble state-${state}`} aria-hidden="true" transform="translate(28,-29)">
    <circle className="agent-state-bubble-tail" cx="-13" cy="17" r="2" />
    <circle className="agent-state-bubble-tail" cx="-9" cy="12" r="3" />
    <g className="agent-state-bubble-face">
      {urgent && <circle className="agent-state-bubble-alert" r="20" />}
      <circle className="agent-state-bubble-surface" r={urgent ? 17 : 14} />
      <g className="agent-state-bubble-symbol-motion"><AgentStateSymbol state={state} className="agent-state-bubble-symbol" x={urgent ? -10 : -8} y={urgent ? -10 : -8} width={urgent ? 20 : 16} height={urgent ? 20 : 16} strokeWidth={2} /></g>
    </g>
  </g>;
}
