import type { ReactNode } from 'react';
import { projectGradient } from './project-gradient';
import { Button } from './Button';
import { markdownPlain } from './markdown-plain';
import type { MouseEvent } from 'react';
import { ArrowUpRight, Clock3, Folder, type LucideIcon } from 'lucide-react';
import './explore-project-card.css';
import { recruitmentState, startLabel } from './recruitment';
import { statusTone, toneClass } from './tag-tone';
import { PrivateBadge, PrivateNote } from './PrivateBadge';
import { MoreMenu, type HeaderMenuItem } from './ProjectHeader';

// "Ready to start" already says the minimum is met, so "Minimum reached" is added only to the open status.
const OPEN_STATUS = 'Open to new people';
const REVIEW_HELP = 'A reviewer will review your proposal. After approval, you finish setup and publish it to Explore.';

/**
 * The one production project card (small cards, owner direction 18 October 2026): a pastel swatch holding only the
 * category icon, then the category, title, a two-line summary, one meta line (status tag and visibility), the seats
 * and a thin "View project" button. It serves Explore, My projects and onboarding. The title is the card's open
 * control and stretches over the whole card.
 */
export function ExploreProjectCard({ projectId, title, summary, category, status, participantCount, onOpen, actionLabel = 'View project', onAction, reviewPending = false, minContributors, startDeadline, recruiting = false, statusHelp, visibilityLabel, headingLevel = 2, icon, private: isPrivate = false, menu, footerAction, ribbon, actions }: {
  /** A diagonal corner ribbon (a pending invitation). */
  ribbon?: string;
  /** Replaces the open button at the card's bottom (invitation Accept / Decline). */
  actions?: ReactNode;
  /** Manage actions behind a ⋯ button on the swatch (My projects). */
  menu?: HeaderMenuItem[]; footerAction?: ReactNode;
  statusHelp?: string; visibilityLabel?: string;
  /** A private project: the lock on the swatch, as on the menu's stamps (My projects; Explore lists public projects only). */
  private?: boolean;
  projectId: string; title: string; summary: string; category: string; status: string;
  minContributors?: number | null; startDeadline?: string | null; recruiting?: boolean;
  headingLevel?: 2 | 3;
  /** Category icon, or no icon on personal cards. The gradient always uses the stable project ID. */
  icon?: LucideIcon | null;
  participantCount: number | null; reviewPending?: boolean; actionLabel?: string; onAction?: (event: MouseEvent<HTMLButtonElement>) => void; onOpen?: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  const Heading = headingLevel === 3 ? 'h3' : 'h2';
  const Icon = icon === undefined ? Folder : icon;
  const open = onOpen ?? onAction;
  // Seats: joined people against the minimum, only while the project is recruiting and both numbers are known.
  const seats = recruitmentState(recruiting && !reviewPending ? minContributors : null, participantCount, null, 0);
  const people = visibilityLabel ?? (reviewPending ? 'Not public yet' : participantCount === null ? 'People unknown' : `${participantCount} ${participantCount === 1 ? 'person' : 'people'}`);
  // The long help is a tooltip and screen-reader text; the card shows only the small status tag.
  const help = statusHelp ?? (reviewPending ? REVIEW_HELP : undefined);
  const bar = seats.remaining !== null;
  const left = recruiting && !reviewPending ? startLabel(startDeadline, Date.now()) : null;
  return <article className={`k42-explore-card${ribbon ? ' has-ribbon' : ''}`}>
    {ribbon && <span className="k42-card-ribbon">{ribbon}</span>}
    <div className="k42-card-swatch" style={{ background: projectGradient(projectId) }} aria-hidden="true">{Icon && <Icon className="k42-card-swatch-icon" size={30} strokeWidth={1.75} />}{isPrivate && <PrivateBadge />}</div>
    {menu && menu.length > 0 && <div className="k42-card-more"><MoreMenu items={menu} label={`More actions for ${title}`} className="k42-card-more-button" /></div>}
    <div className="k42-explore-card-body">
      <p className="k42-card-category">{category}</p>
      <Heading>{open ? <Button className="k42-explore-title" onClick={open}>{title}</Button> : <span className="k42-explore-title">{title}</span>}{isPrivate && <PrivateNote />}</Heading>
      <p className="k42-explore-summary">{markdownPlain(summary)}</p>
      <div className="k42-card-state">
        <div className="k42-card-meta">
          <span className={`k42-category-tag k42-card-status${toneClass(statusTone(status))}`} title={help}>{reviewPending && <Clock3 size={13} aria-hidden="true" />}{status}{help && <span className="visually-hidden">. {help}</span>}</span>
          {seats.minimumReached && status === OPEN_STATUS && <span className="k42-category-tag">Minimum reached</span>}
          {(bar ? visibilityLabel : people) && <span className="k42-card-people">{bar ? visibilityLabel : people}</span>}
          {!bar && left && <span className="k42-card-people">{left}</span>}
        </div>
        {bar && <span className="k42-card-seats">
          <span className="visually-hidden">{seats.count} of {seats.minimum} people needed have joined.</span>
          <span className="k42-card-seats-track" aria-hidden="true"><span style={{ width: `${Math.round(seats.progress! / seats.minimum! * 100)}%` }} /></span>
          <span className="k42-card-seats-count"><span className="k42-card-seats-joined" aria-hidden="true">{seats.count}/{seats.minimum}{left && ' ·'}</span>{left && <span className="k42-card-seats-left">{left}</span>}</span>
        </span>}
      </div>
      {footerAction}
      {actions ?? <Button className="k42-explore-open" onClick={onAction ?? onOpen} aria-label={`${actionLabel}: ${title}`}>{actionLabel} <ArrowUpRight size={14} aria-hidden="true" /></Button>}
    </div>
  </article>;
}
