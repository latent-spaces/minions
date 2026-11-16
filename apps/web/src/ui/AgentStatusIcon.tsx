import { Circle, MessageCircle, CircleHelp, Hand, Hourglass, Pause, Settings, Square, Check, WifiOff, Ban } from './icons';
import type { LucideProps } from './icons';
import type { CommunicationAgentState } from '@minions/contracts';
import { COMMUNICATION_AGENT_LABELS } from './communication-agent-state';
import { agentIconState } from './agent-status-icon';
import './agent-state-bubble.css';

/** Shared by the SVG map bubble and compact HTML status indicators. */
export function AgentStateSymbol({ state, ...props }: LucideProps & { state: CommunicationAgentState }) {
  const Icon = state === 'working' ? Settings : state === 'talking' ? MessageCircle : state === 'waiting' || state === 'pausing' ? Hourglass
    : state === 'needs_you' || state === 'blocked' ? Hand : state === 'idle' ? Circle
    : state === 'paused' ? Pause : state === 'completed' ? Check
    : state === 'offline' ? WifiOff : state === 'revoked' ? Ban
    : state === 'unknown' || state === 'pause_unconfirmed' ? CircleHelp : Square;
  return <Icon {...props} />;
}

/** Labels remain supplied by each surface; only the icon presentation is unified. */
export function AgentStatusIcon({ state, label, overlay = false, decorative = false }: {
  state?: CommunicationAgentState; label?: string; overlay?: boolean; decorative?: boolean;
}) {
  const resolved = state ?? agentIconState(label ?? 'Unknown');
  const name = label ?? COMMUNICATION_AGENT_LABELS[resolved];
  return <span className={`k42-agent-status-icon state-${resolved}${overlay ? ' is-overlay' : ''}`} title={name}
    {...decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': name }}>
    <span className="agent-state-bubble-symbol-motion"><AgentStateSymbol state={resolved} size={14} strokeWidth={2} aria-hidden="true" /></span>
  </span>;
}
