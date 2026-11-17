import type { PublicPhoto } from '../profile-photo-api';
import './profile-photo.css';
import { useContext, useEffect, useRef, useState, type CSSProperties } from 'react';
import { personTone, type PastelTone } from './avatar-tone';
import { PersonPresence } from './person-presence';
import { personInitials } from './person-initials';
import type { PersonCharacter } from '@minions/contracts';
import { personPortrait, personCharacter } from './character-set';
import { CharacterAvatar } from './CharacterAvatar';
import { usePersonCharacter } from './person-character-store';

/** Saved character, then consented photo, then stable default; failed images use initials. */
export function PersonAvatar({ name, id, photo, character, tone = name ? personTone(name.trim()) : undefined, size }: { name: string | null; id?: string; photo?: PublicPhoto | null; character?: PersonCharacter | null; tone?: PastelTone; size?: number }) {
  const element = useRef<HTMLSpanElement>(null);
  const { register, deadlines, now } = useContext(PersonPresence);
  useEffect(() => id && element.current ? register(id, element.current) : undefined, [id, register]);
  const online = !!id && (deadlines.get(id) ?? 0) > now;
  const label = online ? 'Online in the web app' : 'Offline';
  const [failed, setFailed] = useState<string | null>(null);
  const chosen = usePersonCharacter(id, character);
  const photoUrl = id && photo && photo.url === `/api/profiles/${encodeURIComponent(id)}/photo/${encodeURIComponent(photo.id)}` ? photo.url : null;
  const url = id && name ? chosen ? personPortrait(id, chosen) : photoUrl ?? personPortrait(id) : null;
  const style: CSSProperties | undefined = size ? { width: size, height: size, flexBasis: size, fontSize: Math.max(7, Math.round(size * 0.38)) } : undefined;
  return <span className={tone ? `k42-person-avatar k42-tone-${tone}` : 'k42-person-avatar'} style={style} ref={element}><span data-character-motion-root="" className={`k42-person-picture${url && (chosen || !photoUrl) ? ' is-character' : ''}`} aria-hidden="true">{url && failed !== url ? (chosen || !photoUrl) && id ? <CharacterAvatar key={url} character={personCharacter(id, chosen)} animationKey={id} src={url} onError={() => setFailed(url)} /> : <img src={url} alt="" referrerPolicy="no-referrer" onError={() => setFailed(url)} /> : name && personInitials(name)}</span>{id && <span className={`k42-person-presence${online ? ' is-online' : ''}`} role="img" aria-label={`${name ?? 'Person'}: ${label}`} title={label} />}</span>;
}
