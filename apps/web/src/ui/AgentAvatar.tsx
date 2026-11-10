import { agentHat } from './agent-hat';
import type { PersonaChoice } from '@mlswarm/contracts';
import type { PublicPhoto } from '../profile-photo-api';
import type { CSSProperties } from 'react';
import { agentPortrait, ANIMAL_ZOOM, ANIMAL_FOCUS } from './animal-family';
import { PersonAvatar } from './PersonAvatar';
import './agent-avatar.css';

/** `decorative` hides it from assistive tech where the agent's name is already written beside it.
 *  An agent: a rounded square with its animal portrait (owner, 19 October 2026: faces in place of the bot glyph); its owner's circle sits on the corner when the owner is known (option 4, "Agents belong to people"). */
export function AgentAvatar({ name, id, ownerName, ownerId, ownerPhoto, size = 32, image, persona, decorative = false }: { name: string; id: string; ownerName?: string | null; ownerId?: string | null; ownerPhoto?: PublicPhoto | null; size?: number; image?: string; persona?: PersonaChoice | null; decorative?: boolean }) {
  const portrait = agentPortrait(id, ownerId);
  const hat = image ? null : agentHat(persona, portrait.family);
  const label = (ownerName ? `${name}, agent of ${ownerName}` : `${name}, agent`) + (hat ? ` · ${hat.label} persona` : '');
  const style = { '--k42-agent-size': `${size}px`, '--k42-animal-zoom': ANIMAL_ZOOM, '--k42-animal-focus': `${ANIMAL_FOCUS * 100}%` } as CSSProperties;
  return <span className={`k42-agent-avatar${portrait.tone ? ` k42-tone-${portrait.tone}` : ''}`} style={style} title={hat ? `${hat.label} persona` : undefined} {...decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label }}>
    <span className={`k42-agent-portrait${image ? ' is-custom' : ''}`}><img src={image ?? portrait.src} alt="" loading="lazy" decoding="async" /></span>
    {hat && <img className="k42-agent-hat" src={hat.src} alt="" aria-hidden="true" decoding="async"
      style={{width: `${hat.width*100}%`, left: `${hat.left*100}%`, top: `${hat.top*100}%`}} />}
    {ownerName && <span className="k42-agent-owner"><PersonAvatar id={ownerId ?? undefined} photo={ownerPhoto} name={ownerName} size={Math.round(size * 0.45)} /></span>}
  </span>;
}
