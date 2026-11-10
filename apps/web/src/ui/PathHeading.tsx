import { useRef, type Ref } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { formatRoute, mayLeaveProject, type Route } from '../route';
import { NavLink } from '../shared';
import './path-heading.css';

export function PathHeading({ title, parents = [], go, id, headingRef, tabIndex, routeBase = '', trail = true }: {
  title: string; parents?: { label: string; to?: Route }[]; go?: (route: Route) => void;
  id?: string; headingRef?: Ref<HTMLHeadingElement>; tabIndex?: number; routeBase?: string;
  // Inside a project's tabs the tabs and the page's own back link already place you, so no trail (owner, 19 October 2026).
  trail?: boolean;
}) {
  const levels = [{ label: 'Home', to: { view: 'projects' } as Route }, ...parents];
  const earlier = useRef<HTMLDetailsElement>(null);
  const link = (level: { label: string; to?: Route }) => !level.to ? <span>{level.label}</span> : go && !routeBase
    ? <NavLink to={level.to} go={next => { if (earlier.current) earlier.current.open = false; go(next); }}>{level.label}</NavLink>
    : <a href={`${routeBase}${formatRoute(level.to)}`} onClick={event => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (!mayLeaveProject()) event.preventDefault();
    }}>{level.label}</a>;
  // Breadcrumb trail sits above the title so the page title keeps one position at every depth (owner direction, 16 October 2026).
  if (!trail) return <div className="k42-path-heading"><h1 id={id} ref={headingRef} tabIndex={tabIndex} className="k42-path-title">{title}</h1></div>;
  return <div className="k42-path-heading"><nav aria-label="Breadcrumb"><ol>
    {levels.length > 1 && <li className="k42-path-overflow"><details ref={earlier} onKeyDown={event => {
      if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus(); }
    }}><summary aria-label="Show earlier breadcrumb locations"><MoreHorizontal size={18} aria-hidden="true" /></summary>
      <div className="k42-path-earlier">{levels.slice(0, -1).map((level, index) => <span key={index}>{link(level)}</span>)}</div>
    </details></li>}
    {levels.map((level, index) => <li key={index} className={`k42-path-ancestor${index === levels.length - 1 ? ' k42-path-parent' : ''}`} title={level.label}>
      {index > 0 && <span className="k42-path-separator" aria-hidden="true">/</span>}{link(level)}
    </li>)}
  </ol></nav>
  <h1 id={id} ref={headingRef} tabIndex={tabIndex} className="k42-path-title">{title}</h1></div>;
}
