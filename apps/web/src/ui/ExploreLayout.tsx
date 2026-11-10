import { PathHeading } from './PathHeading';
import type { Route } from '../route';
import { useId, type ReactNode, type Ref } from 'react';
import { Search } from 'lucide-react';
import './explore.css';

// No page search and no Create button here: the top bar searches Explore, and creating starts from the + beside
// Your projects (shell polish 2026-10-18, section 12). A page that filters only what it shows passes `onSearch`.
export function ExploreLayout({ search = '', onSearch, trail = true, count, headingRef, title = 'Explore', description = 'Find something worth building together.', resultsLabel = 'Community projects', searchLabel = 'Search projects', sideRail, intro, filters, children, go }: {
  search?: string; onSearch?: (value: string) => void;
  /** My projects shows its title without the Home trail (owner, 19 October 2026). */
  trail?: boolean;
  go?: (route: Route) => void;
  title?: string; description?: string; resultsLabel?: string; searchLabel?: string; sideRail?: ReactNode; intro?: ReactNode; filters?: ReactNode;
  count?: number; headingRef?: Ref<HTMLHeadingElement>; children: ReactNode;
}) {
  const titleId = useId();
  return <section className="explore k42-reveal" aria-labelledby={titleId}>
    <header className="explore-heading">
      <div className="explore-title"><PathHeading trail={trail} go={go} title={title} id={titleId} headingRef={headingRef} tabIndex={-1} /></div>
      {onSearch && <form className="explore-search" role="search" aria-label={searchLabel} onSubmit={event => event.preventDefault()}>
        <Search size={18} aria-hidden="true" /><input aria-label={searchLabel} value={search} maxLength={40} onChange={event => onSearch(event.target.value)} placeholder={searchLabel} />
      </form>}
    </header>
    {intro ?? (description && <p className="explore-description">{description}</p>)}
    {filters}
    <div className={sideRail ? 'explore-columns k42-reveal-skip' : 'k42-reveal-skip'}><div className="explore-results k42-reveal">
      {count !== undefined && <div className="explore-caption"><span>{resultsLabel}</span></div>}
      {children}
    </div>{sideRail && <aside className="explore-trending" aria-label="Related screens">{sideRail}</aside>}</div>
  </section>;
}
