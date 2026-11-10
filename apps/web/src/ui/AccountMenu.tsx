import type { PublicPhoto } from '../profile-photo-api';
import { Button } from './Button';
import { NavLink } from '../shared';
import { useRef } from 'react';
import type { Route } from '../route';
import { PersonAvatar } from './PersonAvatar';
import { usableName } from './display-name';
import './account-menu.css';
import { CircleHelp, Laptop, LogOut, MessageSquareHeart } from 'lucide-react';

/** The account menu in the top bar: the round avatar, opening to My computers, the overview and Sign out. */
export function AccountMenu({ personId, photo, go, signOut, onOverview, onFeedback, name }: { personId?: string; photo?: PublicPhoto | null; go: (route: Route) => void; signOut: () => void; onOverview?: () => void; onFeedback?: () => void; name?: string | null }) {
  const menu = useRef<HTMLDetailsElement>(null);
  const close = () => { if (menu.current) menu.current.open = false; };
  // Until the profile loads there is no name: the avatar stays an empty circle and the identity row is left out.
  const shown = usableName(name);
  const summaryLabel = shown ? `Account menu for ${shown}` : 'Account menu';
  return <details ref={menu} className="k42-account-menu" onKeyDown={event => { if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus(); } }}>
    <summary aria-label={summaryLabel} title={summaryLabel}><PersonAvatar id={personId} photo={photo} name={shown} /></summary><div>
      {shown && <p className="k42-account-identity">{shown}</p>}
      <NavLink to={{view:'computers'}} go={next => { go(next); close(); }}><Laptop size={18} aria-hidden="true" />My computers</NavLink>
      <hr className="k42-account-divider" />
      {onFeedback && <Button onClick={() => { onFeedback(); close(); }}><MessageSquareHeart size={18} aria-hidden="true" />Give us feedback</Button>}
      {onOverview && <Button onClick={() => { onOverview(); close(); }}><CircleHelp size={18} aria-hidden="true" />How MyLittleSwarm works</Button>}
      <hr className="k42-account-divider" />
      <Button onClick={() => { signOut(); close(); }}><LogOut size={18} aria-hidden="true" />Sign out</Button>
    </div>
  </details>;
}
