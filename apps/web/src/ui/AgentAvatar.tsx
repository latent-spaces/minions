import { agentHat } from './agent-hat';
import type { PersonaChoice } from '@mlswarm/contracts';
import { useEffect, useState, type CSSProperties } from 'react';
import { agentPortrait, ANIMAL_ZOOM, ANIMAL_FOCUS } from './animal-family';
import './agent-avatar.css';

/** `decorative` hides it from assistive tech where the agent's name is already written beside it.
 *  An agent: a rounded square with its animal portrait (owner, 19 October 2026: faces in place of the bot glyph). The owner is named in its label only: a project has one owner, so the corner holds the coding tool (owner, 11 November 2026). */
export function AgentAvatar({ name, id, ownerName, ownerId, size = 32, image, persona, decorative = false }: { name: string; id: string; ownerName?: string | null; ownerId?: string | null; size?: number; image?: string; persona?: PersonaChoice | null; decorative?: boolean }) {
  const portrait = agentPortrait(id, ownerId);
  const src = image ?? portrait.src, [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  const hat = image || failed ? null : agentHat(persona, portrait.family);
  const label = (ownerName ? `${name}, agent of ${ownerName}` : `${name}, agent`) + (hat ? ` · ${hat.label} persona` : '');
  const style = { '--k42-agent-size': `${size}px`, '--k42-animal-zoom': ANIMAL_ZOOM, '--k42-animal-focus': `${ANIMAL_FOCUS * 100}%` } as CSSProperties;
  return <span className={`k42-agent-avatar${portrait.tone ? ` k42-tone-${portrait.tone}` : ''}`} style={style} title={hat ? `${hat.label} persona` : undefined} {...decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label }}>
    <span className={`k42-agent-portrait${image ? ' is-custom' : ''}`}>{failed ? <span className="k42-agent-initial" aria-hidden="true">{[...name][0]?.toUpperCase() ?? '?'}</span>
      : <img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />}</span>
    {hat && <img className="k42-agent-hat" src={hat.src} alt="" aria-hidden="true" decoding="async"
      style={{width: `${hat.width*100}%`, left: `${hat.left*100}%`, top: `${hat.top*100}%`}} />}
  </span>;
}
