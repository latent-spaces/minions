import type React from 'react';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { projectGradient } from './project-gradient';
import { Bot, Ellipsis, Link, ArrowUpRight, GitPullRequest, GitMerge } from './icons';
import { canonicalGithubRepo, githubRepositoryParts, type ProjectUsage, type RepositorySummary } from '@minions/contracts';
import { ProjectUsageFigures } from './ProjectUsageFigures';
import { Button } from './Button';
import { personInitials } from './person-initials';
import './project-header.css';

/** The GitHub mark; lucide no longer ships brand icons. */
export function GitHubMark({ size = 18 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" /></svg>;
}

export type HeaderMenuItem = { id: string; label: string; icon: ReactNode; danger?: boolean; onSelect: () => void };

/**
 * The project page's header card, two rows under a thin color strip (option B, owner, 11 November 2026):
 * the stamp, title, status and actions, then the repository and usage as chips.
 * The project's sections are in the menu (owner, 11 November 2026). People, agents and the map live in the map toolbar on Tasks.
 */
export function ProjectHeader({ id, name, cover, statusPanel, limits, repoUrl, repositorySummary, usage, onCopyLink, menu, onContribute, observed, about, titleLevel = 1, repository = true }: {
  about?: ReactNode;
  /** false leaves the repository row out, for a host that shows ProjectRepository elsewhere (phones scroll it with the tab). */
  repository?: boolean;
  titleLevel?: 1 | 2;
  id: string; name: string; /** Time and token limits for the job, in the header with the status (owner, 16 November 2026). */ limits?: React.ReactNode; /** A loaded image URL for the stamp: the screenshot on the newest update. */ cover?: string | null; /** The project status panel, above the repository bar (Noa, 26 October 2026). */ statusPanel?: ReactNode; repoUrl?: string | null;
  repositorySummary?: RepositorySummary | null; usage?: ProjectUsage | null;
  /** Copies the public project's link. */
  onCopyLink?: (() => void) | null; menu: HeaderMenuItem[]; onContribute?: (() => void) | null; observed?: ReactNode;
}) {
  const titleId = useId();
  return <section className="k42-ph" aria-labelledby={titleId}>
    <div className="k42-ph-cover" style={{ background: projectGradient(id) }} aria-hidden="true" />
    <div className="k42-ph-head">
      <div className="k42-ph-title">
        <span className="k42-ph-stamp" style={{ background: projectGradient(id) }} aria-hidden="true">{cover ? <img src={cover} alt="" /> : personInitials(name)}</span>
        <div className="k42-ph-text">
          {titleLevel === 1 ? <h1 id={titleId}>{name}</h1> : <h2 id={titleId} className="k42-ph-name">{name}</h2>}
          {/* What kind of project this is, under the title (Noa, 26 October 2026). */}
          {about && <p className="k42-ph-links">{about}</p>}
          {observed}
        </div>
        <div className="k42-ph-actions">
          {onContribute && <Button type="button" className="k42-ph-thin k42-ph-contribute" onClick={onContribute}><Bot size={18} aria-hidden="true" />Add agent</Button>}
          {onCopyLink && <Button type="button" className="k42-ph-thin" onClick={onCopyLink}><Link size={18} aria-hidden="true" />Copy project link</Button>}
          {menu.length > 0 && <MoreMenu items={menu} />}
        </div>
      </div>
      {/* One bottom row: time and tokens, then the project's own controls such as pause and archive (owner, 16 November 2026). */}
      {(limits || statusPanel) && <div className="k42-ph-limits">{limits}{statusPanel && <div className="k42-ph-visibility">{statusPanel}</div>}</div>}
      {repository && <ProjectRepository repoUrl={repoUrl} summary={repositorySummary} usage={usage} />}
    </div>
  </section>;
}

/** The repository link and PR filters are separate destinations. Counts are explicitly
 * observations, with drafts included in open PRs, never inferred from missing data. */
export function ProjectRepository({ repoUrl, summary, usage }: { repoUrl?: string | null; summary?: RepositorySummary | null; usage?: ProjectUsage | null }) {
  const noteId = useId();
  const parts = githubRepositoryParts(repoUrl);
  if (!parts) return usage ? <section className="k42-ph-repository" aria-label="Project token usage"><div className="k42-ph-repo-strip"><ProjectUsageFigures usage={usage} /></div></section> : null;
  const name = `${parts.owner}/${parts.name}`;
  const repository = `https://github.com/${name}`;
  const counts = summary?.status === 'observed' && canonicalGithubRepo(summary.repository) === canonicalGithubRepo(repository) ? summary : null;
  const note = !counts ? 'No PR update available yet. Open GitHub for the latest.'
    : `Latest available counts${counts.lastSyncAt === null ? '' : ` · Updated ${new Date(counts.lastSyncAt).toLocaleString()}`}.${counts.syncFailed ? ' Waiting for a new update.' : ''}${counts.lastSyncAt === null ? ' Counts may be incomplete.' : ''} Drafts are included in open PRs.${counts.merged === null ? ' Merged count not available yet.' : ''}`;
  return <section className="k42-ph-repository" aria-label="Project repository">
    <div className="k42-ph-repo-strip">
      <a className="k42-ph-repo-link" href={repository} target="_blank" rel="noreferrer">
        <GitHubMark size={20} /><strong>{name}<ArrowUpRight size={14} /></strong><span className="visually-hidden">Project repository</span>
        <span className="visually-hidden"> (opens in a new tab)</span>
      </a>
      <div className="k42-ph-repo-counters" aria-describedby={noteId} title={note}>
        <a data-tip="Open PRs" href={`${repository}/pulls?q=is%3Apr+is%3Aopen`} target="_blank" rel="noreferrer" aria-label={`${counts ? `${counts.open} open pull requests, latest available count` : 'Open pull requests'} on GitHub (opens in a new tab)`}>
          <GitPullRequest size={16} />{counts && <b>{counts.open}</b>}<span className="visually-hidden">Open PRs</span>
        </a>
        <a data-tip="Merged PRs" href={`${repository}/pulls?q=is%3Apr+is%3Amerged`} target="_blank" rel="noreferrer" aria-label={`${counts?.merged != null ? `${counts.merged} merged pull requests, latest available count` : 'Merged pull requests'} on GitHub (opens in a new tab)`}>
          <GitMerge size={16} />{counts?.merged != null && <b>{counts.merged}</b>}<span className="visually-hidden">Merged PRs</span>
        </a>
      </div>
      <ProjectUsageFigures usage={usage} />
    </div>
    <p id={noteId} className="visually-hidden">{note}</p>
  </section>;
}

/** The ⋯ menu: opens below its trigger, kept inside the viewport; Escape and an outside click close it and
 *  return focus to the trigger; the arrow keys, Home and End move between items. */
export function MoreMenu({ items, label = 'More project actions', className = 'k42-ph-thin' }: { items: HeaderMenuItem[]; label?: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), list = useRef<HTMLDivElement>(null);
  const close = (refocus: boolean) => { setOpen(false); if (refocus) trigger.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    list.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); close(true); return; }
    const buttons = Array.from(list.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'ArrowDown' ? (at + 1) % buttons.length : event.key === 'ArrowUp' ? (at - 1 + buttons.length) % buttons.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : -1;
    if (next >= 0) { event.preventDefault(); buttons[next]?.focus(); }
  };
  return <div className="k42-ph-more" ref={root}>
    <button ref={trigger} type="button" className={className} aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)}><Ellipsis size={18} aria-hidden="true" /></button>
    {open && <div ref={list} className="k42-ph-menu" role="menu" aria-label={label} onKeyDown={keys}>{items.map(item => <button key={item.id} type="button" role="menuitem" tabIndex={-1} className={item.danger ? 'is-danger' : undefined}
      onClick={() => { close(false); item.onSelect(); }}>{item.icon}{item.label}</button>)}</div>}
  </div>;
}
