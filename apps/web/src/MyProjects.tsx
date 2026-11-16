import { useLeaveProject, LeaveProjectFeedback } from './LeaveProject';
import { usePrivateProjectRequest } from './PrivateProjects';
import { Button } from './ui/Button';
import { useEffect, useRef, useState } from 'react';
import type { SessionUser } from './session-identity';
import { projects } from './api';
import type { PersonalProjectEntry, PersonalProjectPage } from './project-api';
import { projectRoute, type Route } from './route';
import { Pager } from './shared';
import { ExploreLayout } from './ui/ExploreLayout';
import type { PersonalFilter } from './ui/group-personal-projects';
import { PersonalFilterChips, PersonalProjectGroups } from './ui/PersonalProjectGroups';
import { useProjectCovers } from './project-covers';
import { Archive } from './ui/icons';
import { NewProjectTile } from './ui/NewProjectTile';
import { WelcomeHero } from './ui/WelcomeHero';
import { HomeDashboard } from './ui/HomeDashboard';
import { FirstProject } from './ui/FirstProject';

type ArchiveInput = { archived: boolean; expected_revision: number; client_request_id: string };
type ListAction = { kind: 'archive'; project: PersonalProjectEntry; input: ArchiveInput } | { kind: 'star'; project: PersonalProjectEntry; input: { starred: boolean } };
type ArchiveResult = { id: string; archived: boolean; archiveRevision: number };
export function MyProjects({ user, active, refreshKey, go, retry, view = 'current', onArchiveChange }: { user: SessionUser; active: boolean; refreshKey: number; go: (to: Route) => void; retry: () => void; view?: 'current' | 'archived'; onArchiveChange?: (id: string, archived: boolean) => void }) {
  const leave = useLeaveProject(user, retry);
  const identity = usePrivateProjectRequest(user, active);
  const [poll, setPoll] = useState(0);
  useEffect(() => { if (!active) return; const timer = window.setInterval(() => { if (document.visibilityState === 'visible') setPoll(value => value + 1); }, 30000); return () => window.clearInterval(timer); }, [active]);
  const [search, setSearch] = useState('');
  // Archived is its own route and data.
  const groupFilter: PersonalFilter = view === 'archived' ? 'archived' : 'all';
  const [paging, setPaging] = useState<{ view: string; cursors: (string | null)[] }>({ view, cursors: [null] });
  const cursors = paging.view === view ? paging.cursors : [null], cursor = cursors.at(-1) ?? null;
  const key = `${view}:${cursor ?? ''}`;
  const [result, setResult] = useState<{ key: string; page: PersonalProjectPage | null; error: string | null } | null>(null);
  const [pending, setPending] = useState<ListAction | null>(null);
  const [busy, setBusy] = useState(false), [writeError, setWriteError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const chipRow = useRef<HTMLDivElement>(null);
  // The other list's first page, for its chip count only.
  const [other, setOther] = useState<{ view: string; projects: PersonalProjectEntry[] } | null>(null);
  const readGeneration = useRef(0), mounted = useRef(true), writing = useRef(false);
  const returnFocus = useRef(false);
  useEffect(() => {
    if (!busy && returnFocus.current) {
      returnFocus.current = false;
      if (active) chipRow.current?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')?.focus({ preventScroll: true });
    }
  }, [busy, active, view]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setSearch(''); }, [view]);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const generation = ++readGeneration.current;
    projects<PersonalProjectPage>(user, `/mine?view=${view}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`).then(page => {
      if (!cancelled && generation === readGeneration.current) setResult({ key, page, error: null });
    }, (e: Error) => { if (!cancelled && generation === readGeneration.current) setResult(r => ({ key, page: r?.key === key ? r.page : null, error: e.message })); });
    return () => { cancelled = true; };
  }, [user, key, cursor, view, refreshKey, active, poll]);
  const otherView = view === 'current' ? 'archived' : 'current';
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    projects<PersonalProjectPage>(user, `/mine?view=${otherView}`).then(next => { if (!cancelled) setOther({ view: otherView, projects: next.projects }); }, () => undefined);
    return () => { cancelled = true; };
  }, [user, otherView, refreshKey, active, poll]);
  const reload = () => { readGeneration.current++; setResult(null); setPending(null); setWriteError(null); setPoll(value => value + 1); retry(); identity.retry(); };
  const changeArchive = async (project: PersonalProjectEntry, saved?: ArchiveInput) => {
    if (writing.current || !identity.ready) return;
    const input = saved ?? { archived: !project.archived, expected_revision: project.archiveRevision ?? 0, client_request_id: crypto.randomUUID() };
    writing.current = true; setBusy(true); setWriteError(null); setPending({ kind: 'archive', project, input });
    try {
      const receipt = await identity.request<ArchiveResult>(`/${project.id}/personal-archive`, input);
      if (receipt.id !== project.id || receipt.archived !== input.archived) throw new Error('The archive action could not be confirmed. Retry the same action.');
      if (!mounted.current) return;
      readGeneration.current++; setResult(null); setPoll(value => value + 1); setPending(null);
      setNotice(input.archived ? 'Project moved to your archive.' : 'Project restored to your current list.');
      onArchiveChange?.(project.id, input.archived);
      returnFocus.current = true;
    } catch (error) { if (mounted.current) setWriteError((error as Error).message); }
    finally { writing.current = false; if (mounted.current) setBusy(false); }
  };
  const changeStar = async (project: PersonalProjectEntry, saved?: { starred: boolean }) => {
    if (writing.current || !identity.ready) return;
    const input = saved ?? { starred: !project.starred };
    writing.current = true; setBusy(true); setWriteError(null); setPending({ kind: 'star', project, input });
    try {
      const { starred } = input;
      const receipt = await identity.request<{ id: string; starred: boolean }>(`/${project.id}/personal-star`, { starred });
      if (receipt.id !== project.id || receipt.starred !== starred) throw new Error('The star could not be confirmed. Try again.');
      if (!mounted.current) return;
      readGeneration.current++; setResult(null); setPoll(value => value + 1); setPending(null);
      setNotice(starred ? 'Starred. It stays in your menu.' : 'Star removed.');
      onArchiveChange?.(project.id, !!project.archived);
    } catch (error) { if (mounted.current) setWriteError((error as Error).message); }
    finally { writing.current = false; if (mounted.current) setBusy(false); }
  };
  const shown = result?.key === key ? result : null, page = shown?.page ?? null;
  // While All and Archived swap, the welcome, heading and chips keep the last loaded page so nothing jumps (owner, 16 November 2026).
  const steady = useRef<PersonalProjectPage | null>(null);
  if (page) steady.current = page;
  const frame = page ?? steady.current;
  const query = search.trim().toLocaleLowerCase();
  const matches = page?.projects.filter(project => `${project.name} ${project.summary}`.toLocaleLowerCase().includes(query));
  const covers = useProjectCovers(user, page?.projects ?? []);
  const first = cursors.length === 1;
  // The first-run flow stays on screen until its popup is done, even after the first project appears; while it waits for
  // that project, the list is read every 5 seconds (owner, 16 November 2026).
  const isFirstRun = view === 'current' && !!frame && !frame.projects.length && !frame.next && cursors.length === 1;
  const [firstFlow, setFirstFlow] = useState(false), [waitingFirst, setWaitingFirst] = useState(false);
  // The tour can always be skipped: an empty list also means someone who archived or left every project, and with the
  // menu hidden they had no way out but making a project (review of PR 68, owner, 16 November 2026).
  const [replay, setReplay] = useState(false), [skipped, setSkipped] = useState(false);
  const touring = replay || ((isFirstRun || firstFlow) && !skipped);
  const replayTour = () => setReplay(true);
  const skipTour = () => { setReplay(false); setFirstFlow(false); setWaitingFirst(false); setSkipped(true); };
  useEffect(() => { if (isFirstRun) setFirstFlow(true); }, [isFirstRun]);
  useEffect(() => { if (!waitingFirst || !active) return; const timer = setInterval(() => setPoll(value => value + 1), 5000); return () => clearInterval(timer); }, [waitingFirst, active]);
  const showGroups = !!page && !!matches?.length;
  const otherProjects = other?.view === otherView ? other.projects : [];
  const choose = (next: PersonalFilter) => {
    if (next === 'archived') { if (view !== 'archived') go({ view: 'projects', projectList: 'archived' }); }
    else if (view === 'archived') go({ view: 'projects' });
  };
  const chips = frame && <div ref={chipRow}><PersonalFilterChips projects={view === 'current' ? page?.projects ?? [] : otherProjects} archived={view === 'archived' ? page?.projects ?? [] : otherProjects} value={groupFilter} disabled={busy} onChange={choose} /></div>;
  return <ExploreLayout go={go} title="Home" description="" trail={false}>
    {notice && <p className="personal-project-notice" role="status">{notice}</p>}
    {identity.error && <div role="alert"><p>{identity.error}</p><Button onClick={identity.retry}>Check account again</Button></div>}
    {writeError && <div role="alert"><p>Could not change your project list: {writeError}</p><div className="actions"><Button disabled={busy || !identity.ready} onClick={() => { if (pending?.kind === 'archive') void changeArchive(pending.project, pending.input); else if (pending?.kind === 'star') void changeStar(pending.project, pending.input); }}>Retry action</Button><Button disabled={busy} onClick={reload}>Reload projects</Button></div></div>}
    {shown?.error && <div role="alert"><p className="error">Could not load your projects: {shown.error}</p><Button disabled={busy} onClick={reload}>Try again</Button></div>}
    <LeaveProjectFeedback controls={leave} />
    {/* The welcome stays on top in both lists; All and Archived only swap the projects under it (owner, 16 November 2026). */}
    {frame && first && !query && (view === 'current' && touring
      ? <FirstProject created={!replay && !isFirstRun && page?.projects[0] ? { id: page.projects[0].id, name: page.projects[0].name } : null} onWaiting={setWaitingFirst}
          onOpenProject={id => { setReplay(false); setFirstFlow(false); setWaitingFirst(false); go(projectRoute(id, 'overview')); }} onDone={() => { setReplay(false); setFirstFlow(false); setWaitingFirst(false); }} onSkip={skipTour} />
      : <><WelcomeHero />{view === 'current' && frame && <HomeDashboard user={user} projectIds={frame.projects.map(p => p.id)} />}{view === 'current' && <button type="button" className="k42-replay-tour" onClick={replayTour}>Replay the tour</button>}</>)}
    {/* The welcome replaces the page title; the list's own heading carries All and Archived (owner, 16 November 2026). */}
    {frame && !(view === 'current' && touring) && <div className="k42-projects-bar"><h2 className="k42-projects-heading">Your projects</h2>{chips}</div>}
    {!shown && <p className="muted" role="status">Loading projects…</p>}
    <div className="project-directory-grid k42-reveal my-projects-grid">
      {showGroups && <PersonalProjectGroups covers={covers} onLeave={id => void leave.act(id)} projects={matches ?? []} go={go} searching={!!query} archived={view === 'archived'} onArchive={project => void changeArchive(project)} onStar={project => void changeStar(project)} disabled={busy || !!pending || leave.busy || !!leave.pending || !identity.ready || !!shown?.error} />}
    </div>
    {/* With no projects yet, the grid still starts with the new-project tile (owner, 16 November 2026). */}
    {page && !showGroups && view === 'current' && !query && first && !page.next && !touring && <div className="project-directory-grid my-projects-grid"><div className="personal-project-groups"><NewProjectTile /></div></div>}
    {page && !showGroups && <div className="project-directory-empty"><p>{query ? 'No projects on this page match your search.' : first && !page.next ? '' : `No ${view} projects on this page.`}</p>{!query && view === 'archived' && first && !page.next && <div className="k42-empty-row"><span className="k42-empty-row-icon" aria-hidden="true"><Archive size={18} /></span><div><strong>Nothing archived.</strong><span>Archive a project from its ··· menu. Restore it any time.</span></div></div>}</div>}
    <Pager first={first} hasNext={!!page?.next} onBack={() => { setSearch(''); setPaging({ view, cursors: cursors.slice(0, -1) }); }} onNext={() => { if (page?.next) { setSearch(''); setPaging({ view, cursors: [...cursors, page.next] }); } }} nextLabel="More projects" />
  </ExploreLayout>;
}
