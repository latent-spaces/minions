import type { ReactNode } from 'react';
import { formatRoute, type Route } from './route';

// A real link, so a location can be opened in a new tab or copied; a plain click stays in the viewer.
export function NavLink({ to, go, current = false, className, children }: { to: Route; go: (to: Route) => void; current?: boolean; className?: string; children: ReactNode }) {
  return <a href={formatRoute(to)} className={className} aria-current={current ? 'page' : undefined} onClick={e => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault(); go(to);
  }}>{children}</a>;
}
