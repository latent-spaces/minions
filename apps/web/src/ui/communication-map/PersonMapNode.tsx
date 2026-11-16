import type { MapNode } from './protocol';
import { PersonAvatar } from '../PersonAvatar';
import { pokeCharacter } from '../AvatarPoke';

/** People share the map's camera and ownership colors, without agent state or execution controls. */
export function PersonMapNode({ node, self = false, crowded = false, onSelect, onInspect, onLeave, onDismiss }: { node: MapNode & { x: number; y: number }; self?: boolean; crowded?: boolean; onSelect: () => void; onInspect: (anchor: SVGGElement) => void; onLeave: () => void; onDismiss: () => void }) {
  const name = node.name ?? 'Project member';
  return <g className={`k42-communication-agent k42-communication-person${crowded ? ' is-crowded' : ''}`} role="button" tabIndex={0} aria-label={`Open profile for ${name}`} transform={`translate(${node.x},${node.y})`}
    onMouseEnter={event => onInspect(event.currentTarget)} onMouseLeave={event => { if (document.activeElement !== event.currentTarget) onLeave(); }}
    onFocus={event => onInspect(event.currentTarget)} onBlur={onLeave}
    onClick={event => { pokeCharacter(event.currentTarget); event.currentTarget.focus(); onSelect(); }} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); onDismiss(); } if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); pokeCharacter(event.currentTarget); onSelect(); } }}>
    <rect className="k42-communication-agent-hit" x="-48" y="-30" width="96" height="96" rx="12" />
    <circle className="k42-communication-owner-ring" r="25" aria-hidden="true" />
    <foreignObject x="-20" y="-20" width="40" height="40" pointerEvents="none"><div className="k42-person-map-avatar"><PersonAvatar id={node.personId} photo={node.photo} character={node.character} name={name} size={40} /></div></foreignObject>
    <text y="38" textAnchor="middle" className="k42-communication-name">{[...name].length > 14 ? `${[...name].slice(0, 13).join('')}…` : name}</text>
    <text y="54" textAnchor="middle" className="k42-communication-state">{self ? 'You' : 'Person'}</text>
  </g>;
}
