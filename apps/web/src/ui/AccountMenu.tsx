import type { PublicPhoto } from '../profile-photo-api';
import { Button } from './Button';
import { NavLink } from '../shared';
import { useRef } from 'react';
import type { Route } from '../route';
import { PersonAvatar } from './PersonAvatar';
import { usableName } from './display-name';
import './account-menu.css';
import { Laptop, MessageSquareHeart } from 'lucide-react';

/** The account menu in the top bar: the round avatar, opening to My computers and feedback. */
export function AccountMenu({ personId, photo, go, onFeedback, name }: { personId?: string; photo?: PublicPhoto | null; go: (route: Route) => void; onFeedback?: () => void; name?: string | null }) {
  const menu = useRef<HTMLDetailsElement>(null);
  const close = () => { if (menu.current) menu.current.open = false; };
  // Until the profile loads there is no name: the avatar stays an empty circle and the identity row is left out.
  const shown = usableName(name);
  const summaryLabel = shown ? `Account menu for ${shown}` : 'Account menu';
  return <details ref={menu} className="k42-account-menu" onKeyDown={event => { if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus(); } }}>
    <summary aria-label={summaryLabel} title={summaryLabel}><PersonAvatar id={personId} photo={photo} name={shown} /></summary><div>
      {shown && <p className="k42-account-identity">{shown}</p>}
      <NavLink to={{view:'computers'}} go={next => { go(next); close(); }}><Laptop size={18} aria-hidden="true" />My computers</NavLink>
      {onFeedback && <><hr className="k42-account-divider" /><Button onClick={() => { onFeedback(); close(); }}><MessageSquareHeart size={18} aria-hidden="true" />Give us feedback</Button></>}
    </div>
  </details>;
}
