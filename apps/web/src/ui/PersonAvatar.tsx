import type { PublicPhoto } from '../profile-photo-api';
import './profile-photo.css';
import { useContext, useEffect, useRef, useState, type CSSProperties } from 'react';
import { personTone, type PastelTone } from './avatar-tone';
import { PersonPresence } from './person-presence';
import { personInitials } from './person-initials';

/** A person: a circle with initials on a warm pastel (option 4, 2026-10-18). The tone follows the display name, so one person has one color everywhere.
 *  Without a name (not loaded yet) it is a plain empty circle: no made-up letters or color. */
export function PersonAvatar({ name, id, photo, tone = name ? personTone(name.trim()) : undefined, size }: { name: string | null; id?: string; photo?: PublicPhoto | null; tone?: PastelTone; size?: number }) {
  const element = useRef<HTMLSpanElement>(null);
  const { register, deadlines, now } = useContext(PersonPresence);
  useEffect(() => id && element.current ? register(id, element.current) : undefined, [id, register]);
  const online = !!id && (deadlines.get(id) ?? 0) > now;
  const label = online ? 'Online in the web app' : 'Offline';
  const [failed, setFailed] = useState<string | null>(null);
  const url = id && photo && photo.url === `/api/profiles/${encodeURIComponent(id)}/photo/${encodeURIComponent(photo.id)}` ? photo.url : null;
  const style: CSSProperties | undefined = size ? { width: size, height: size, flexBasis: size, fontSize: Math.max(7, Math.round(size * 0.38)) } : undefined;
  return <span className={tone ? `k42-person-avatar k42-tone-${tone}` : 'k42-person-avatar'} style={style} ref={element}><span className="k42-person-picture" aria-hidden="true">{url && failed !== url ? <img src={url} alt="" referrerPolicy="no-referrer" onError={() => setFailed(url)} /> : name && personInitials(name)}</span>{id && <span className={`k42-person-presence${online ? ' is-online' : ''}`} role="img" aria-label={`${name ?? 'Person'}: ${label}`} title={label} />}</span>;
}
