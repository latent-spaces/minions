import { agentHat } from './agent-hat';
import type { PersonaChoice, CommunicationAgentState } from '@mlswarm/contracts';
import { useContext, useEffect, useState, type CSSProperties } from 'react';
import './agent-avatar.css';
import { agentCharacter, ownerTone } from './character-set';
import { CharacterAvatar } from './CharacterAvatar';
import { FixedHatPreview, gazeHatStyle } from './hat-gaze';

/** Stable animal identity; the separate coding-tool badge carries actual provider metadata. */
export function AgentAvatar({ name, id, ownerName, ownerId, size = 32, image, persona, state, decorative = false }: { name: string; id: string; ownerName?: string | null; ownerId?: string | null; size?: number; image?: string; persona?: PersonaChoice | null; provider?: string | null; state?: CommunicationAgentState; decorative?: boolean }) {
  const character = agentCharacter(id), tone = ownerTone(ownerId);
  const fixedHatPreview = useContext(FixedHatPreview);
  const src = image ?? character.src, [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  const hat = image || failed ? null : agentHat(persona, character.id);
  const label = (ownerName ? `${name}, agent of ${ownerName}` : `${name}, agent`) + (hat ? ` · ${hat.label} persona` : '');
  return <span data-character-motion-root="" className={`k42-agent-avatar${tone ? ` k42-tone-${tone}` : ''}${fixedHatPreview ? ' is-fixed-hat-preview' : ''}`} style={{ ...gazeHatStyle(character.id), '--k42-agent-size': `${size}px` } as CSSProperties} title={hat ? `${hat.label} persona` : undefined} {...decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label }}>
    <span className={`k42-agent-portrait${image ? ' is-custom' : ''}`}>{failed ? <span className="k42-agent-initial" aria-hidden="true">{[...name][0]?.toUpperCase() ?? '?'}</span>
      : image ? <img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />
      : <CharacterAvatar key={`${id}:${character.id}`} animationKey={id} character={character.id} src={src} state={state} onError={() => setFailed(true)} />}</span>
    {hat && <img className="k42-agent-hat" src={hat.src} alt="" aria-hidden="true" decoding="async"
      style={{width: `${hat.width*100}%`, left: `${hat.left*100}%`, top: `${hat.top*100}%`, zIndex: hat.behind ? 0 : 2}} />}
  </span>;
}
