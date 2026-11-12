import { agentCharacter, ownerTone } from './character-set';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CommunicationAgent } from '@mlswarm/contracts';
import { AgentStateBubble } from './AgentStateBubble';
import { agentHat } from './agent-hat';
import { AgentAvatar } from './AgentAvatar';
import { ago, time } from '../shared';
import { COMMUNICATION_AGENT_LABELS, communicationAgentState } from './communication-agent-state';
import type { PositionedAgent } from './agent-map';

export function CommunicationAgentNode({ node, agent, now, selected, replay, simulated=false, compact, crowded=false, ownerLabel, tooltipId, inspecting, onInspect, onLeave, onDismiss, onSelect }: {
  node: PositionedAgent & { ownerId?: string | null }; agent?: CommunicationAgent; now: number; selected: boolean; replay: boolean; compact: boolean;
  simulated?: boolean; crowded?: boolean; ownerLabel?: string; tooltipId: string; inspecting: boolean; onInspect: (element: SVGGElement) => void;
  onLeave: () => void; onDismiss: () => void; onSelect: () => void;
}) {
  const name = node.name ?? node.id, state = communicationAgentState(agent, now), label = COMMUNICATION_AGENT_LABELS[state];
  const characters = [...name], limit = compact ? 14 : 22;
  const tone = ownerTone(node.ownerId);
  const character = agentCharacter(node.id);
  const hat = agentHat(agent?.personaChoice, character.id);
  // A working agent shows what it is on right now (owner, from the 19 October onboarding test); the full line is in its title and tooltip.
  const focus = !replay && state === 'working' ? agent?.focus?.text?.trim() ?? '' : '', focusCharacters = [...focus], focusLimit = compact ? 16 : 26;
  return <g role="button" tabIndex={0} aria-label={`Select agent ${name}. ${simulated ? 'Simulated status' : 'Current status'}: ${label}.${ownerLabel ? ` Agent of: ${ownerLabel}.` : ''}${hat ? ` Persona: ${hat.label}.` : ''}${focus ? ` Focus: ${focus}` : ''}`}
    aria-pressed={selected} aria-describedby={inspecting ? tooltipId : undefined}
    className={`k42-communication-agent${!replay || simulated ? ' has-state-bubble' : ''}${selected ? ' selected' : ''}${crowded ? ' is-crowded' : ''}${inspecting ? ' is-inspecting' : ''}`} transform={`translate(${node.x},${node.y})`}
    onMouseEnter={event => onInspect(event.currentTarget)} onMouseLeave={event => { if (document.activeElement !== event.currentTarget) onLeave(); }}
    onFocus={event => onInspect(event.currentTarget)} onBlur={onLeave}
    onClick={event => { event.currentTarget.focus(); onSelect(); onInspect(event.currentTarget); }}
    onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); onDismiss(); }
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(); onInspect(event.currentTarget); }
    }}>
    <rect className="k42-communication-agent-hit" x="-48" y="-30" width="96" height={focus ? 112 : 96} rx="12" />
    {ownerLabel && <rect className="k42-communication-owner-ring" x="-25" y="-25" width="50" height="50" rx="17" aria-hidden="true"/>}
    <rect className="k42-communication-avatar-frame" style={tone ? { fill: `var(--pastel-${tone})` } : undefined} x="-22" y="-22" width="44" height="44" rx="14" />
    <foreignObject x="-32" y="-44" width="64" height="76" style={{overflow:'visible'}}><div style={{ padding: '24px 12px 12px', width: 64, height: 76 }}>
      <AgentAvatar name={name} id={node.id} ownerId={node.ownerId} provider={node.provider}
        state={!replay || simulated ? state : 'idle'} persona={agent?.personaChoice} size={40} decorative />
    </div></foreignObject>
    <text y="38" textAnchor="middle" className="k42-communication-name">{characters.length > limit ? `${characters.slice(0, limit - 1).join('')}…` : name}</text>
    {(!replay || simulated) && <text y="54" textAnchor="middle" className={`k42-communication-state state-${state}`}>{label}</text>}
    {focus && <text y="70" textAnchor="middle" className="k42-communication-focus"><title>{focus}</title>{focusCharacters.length > focusLimit ? `${focusCharacters.slice(0, focusLimit - 1).join('')}…` : focus}</text>}
    {(!replay || simulated) && <AgentStateBubble state={state} />}
  </g>;
}

export function CommunicationAgentTooltip({ id, anchor, name, ownerLabel, ownerId, agentId, provider, agent, now, replay, simulated=false, onKeep, onLeave, onDismiss, onPin, ownStatus, actions, portalContainer }: {
  id: string; anchor: SVGGElement; name: string; ownerLabel?: string; ownerId?: string | null; agentId?: string; provider?: string | null; agent?: CommunicationAgent; now: number; replay: boolean;
  simulated?: boolean;
  // For the person's own agents in the live view: their one-word status and Play/Pause.
  ownStatus?: string; actions?: React.ReactNode; onPin?: () => void; portalContainer?: Element;
  onKeep: () => void; onLeave: () => void; onDismiss: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null), [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const state = communicationAgentState(agent, now);
  useLayoutEffect(() => {
    const place = () => {
      const target = anchor.getBoundingClientRect(), box = ref.current!.getBoundingClientRect();
      const left = Math.max(12, Math.min(window.innerWidth - box.width - 12, target.left + target.width / 2 - box.width / 2));
      const below = target.bottom + 12;
      const top = Math.max(12, Math.min(window.innerHeight - box.height - 12,
        below + box.height <= window.innerHeight - 12 ? below : target.top - box.height - 12));
      setPosition({ left, top });
    };
    const scroll = (event: Event) => {
      const target = event.target;
      if (target === document || target === window || target instanceof Element && target.contains(anchor)) place();
    };
    place();window.addEventListener('communication-map-tick',place); window.addEventListener('scroll', scroll, true);
    return () => {window.removeEventListener('communication-map-tick',place);window.removeEventListener('scroll',scroll,true);};
  }, [anchor, agent?.focus?.text, state, replay]);
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!anchor.contains(event.target as Node) && !ref.current?.contains(event.target as Node)) onDismiss(); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') onDismiss(); };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    // A box with controls stays put while it's used; resizing only closes a plain hover box.
    if (!actions) window.addEventListener('resize', onDismiss);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape);
      window.removeEventListener('resize', onDismiss); };
  }, [anchor, onDismiss, !!actions]);
  return createPortal(<div ref={ref} id={id} role={actions ? 'dialog' : 'tooltip'} aria-label={actions ? name : undefined} className="k42-communication-agent-tooltip"
    style={{ ...position, visibility: position ? 'visible' : 'hidden' }} onMouseEnter={onKeep} onMouseLeave={onLeave} onPointerDown={onPin} onFocus={onPin}>
    {actions && <button type="button" className="k42-communication-tooltip-close" aria-label="Close" onClick={onDismiss}>×</button>}
    <div className="k42-communication-tooltip-identity"><AgentAvatar provider={provider} state={!replay ? state : 'idle'} name={name} id={agentId ?? agent?.id ?? name} ownerId={ownerId} persona={agent?.personaChoice} size={40} decorative /><div><strong>{name}</strong>
      <span>{agent?.mine ? 'Your agent · ' : ''}{simulated ? 'Simulated status' : 'Current status'}: {agent?.projectPause ? COMMUNICATION_AGENT_LABELS[state] : ownStatus ?? COMMUNICATION_AGENT_LABELS[state]}</span></div></div>
    {ownerLabel && <p className="k42-communication-tooltip-owner">Agent of: {ownerLabel}</p>}
    {actions && <div className="k42-communication-tooltip-actions">{actions}</div>}
    {agent?.projectPause && <p className="k42-communication-tooltip-note">Pause requested: {time(agent.projectPause.requestedAt, true, now)}.
      {state === 'paused' ? ' Runtime confirmed that work has paused.' : agent.projectPause.externalChat ? ' This external chat must be paused directly; MyLittleSwarm cannot confirm its execution has stopped.' : ' Waiting for the runtime to confirm that work has paused.'}</p>}
    {replay && <p className="k42-communication-tooltip-note">{simulated ? "Simulated state for this lab. It is not a recorded status or live agent activity." : "Messages are replayed. Persona, status and focus are the latest."}</p>}
    <p className="k42-communication-tooltip-focus" dir="auto">{simulated ? 'Illustrative activity for comparing state indicators.' : agent?.focus?.text || 'This agent hasn’t reported a focus yet.'}</p>
    {agent?.focus && <p className="k42-communication-tooltip-note">Agent reported · <time dateTime={new Date(agent.focus.updatedAt).toISOString()} title={time(agent.focus.updatedAt, false)}>Updated {ago(agent.focus.updatedAt, now) || new Date(agent.focus.updatedAt).toLocaleDateString()}</time></p>}
    {agent?.lastContactAt !== null && agent?.lastContactAt !== undefined && <p className="k42-communication-tooltip-note">Last contact: {time(agent.lastContactAt, true, now)}</p>}
  </div>, portalContainer ?? document.body);
}
