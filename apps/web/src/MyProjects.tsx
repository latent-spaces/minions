import { useLeaveProject, LeaveProjectFeedback } from './LeaveProject';
import { usePrivateProjectRequest } from './PrivateProjects';
import { Button } from './ui/Button';
import { useEffect, useRef, useState } from 'react';
import type { SessionUser } from './session-identity';
import { projects } from './api';
import type { PersonalProjectEntry, PersonalProjectPage } from './project-api';
import type { Route } from './route';
import { Pager } from './shared';
import { ExploreLayout } from './ui/ExploreLayout';
import type { PersonalFilter } from './ui/group-personal-projects';
import { PersonalFilterChips, PersonalProjectGroups } from './ui/PersonalProjectGroups';
import { MessageSquare, Archive } from 'lucide-react';
import { CLAUDE_EXAMPLE_PROMPT, useCopyPrompt } from './ui/ClaudePromptTile';
import { EmptyState } from './ui/EmptyState';

type ArchiveInput = { archived: boolean; expected_revision: number; client_request_id: string };
type ListAction = { kind: 'archive'; project: PersonalProjectEntry; input: ArchiveInput } | { kind: 'star'; project: PersonalProjectEntry; input: { starred: boolean } };
type ArchiveResult = { id: string; archived: boolean; archiveRevision: number };
export function MyProjects({ user, active, refreshKey, go, retry, view = 'current', onArchiveChange }: { user: SessionUser; active: boolean; refreshKey: number; go: (to: Route) => void; retry: () => void; view?: 'current' | 'archived'; onArchiveChange?: (id: string, archived: boolean) => void }) {
  const leave = useLeaveProject(user, retry);
  const identity = usePrivateProjectRequest(user, active);
  const [poll, setPoll] = useState(0);
  useEffect(() => { if (!active) return; const timer = window.setInterval(() => { if (document.visibilityState === 'visible') setPoll(value => value + 1); }, 30000); return () => window.clearInterval(timer); }, [active]);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<PersonalFilter>('all');
  // Archived is its own route and data; the other chips filter the current list.
  const groupFilter: PersonalFilter = view === 'archived' ? 'archived' : filter === 'archived' ? 'all' : filter;
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
  const query = search.trim().toLocaleLowerCase();
  const matches = page?.projects.filter(project => `${project.name} ${project.summary}`.toLocaleLowerCase().includes(query));
  const first = cursors.length === 1;
  const showGroups = !!page && !!matches?.length;
  const copyPrompt = useCopyPrompt();
  const otherProjects = other?.view === otherView ? other.projects : [];
  const choose = (next: PersonalFilter) => {
    if (next === 'archived') { if (view !== 'archived') go({ view: 'projects', projectList: 'archived' }); return; }
    setFilter(next);
    if (view === 'archived') go({ view: 'projects' });
  };
  const chips = page && <div ref={chipRow}><PersonalFilterChips projects={view === 'current' ? page.projects : otherProjects} archived={view === 'archived' ? page.projects : otherProjects} value={groupFilter} disabled={busy} onChange={choose} /></div>;
  return <ExploreLayout go={go} title="My projects" description="" trail={false} filters={chips}>
    {notice && <p className="personal-project-notice" role="status">{notice}</p>}
    {identity.error && <div role="alert"><p>{identity.error}</p><Button onClick={identity.retry}>Check account again</Button></div>}
    {writeError && <div role="alert"><p>Could not change your project list: {writeError}</p><div className="actions"><Button disabled={busy || !identity.ready} onClick={() => { if (pending?.kind === 'archive') void changeArchive(pending.project, pending.input); else if (pending?.kind === 'star') void changeStar(pending.project, pending.input); }}>Retry action</Button><Button disabled={busy} onClick={reload}>Reload projects</Button></div></div>}
    {shown?.error && <div role="alert"><p className="error">Could not load your projects: {shown.error}</p><Button disabled={busy} onClick={reload}>Try again</Button></div>}
    {!shown && <p className="muted" role="status">Loading projects…</p>}
    <LeaveProjectFeedback controls={leave} />
    <div className="project-directory-grid k42-reveal my-projects-grid">
      {showGroups && <PersonalProjectGroups onLeave={id => void leave.act(id)} projects={matches ?? []} go={go} filter={groupFilter === 'archived' ? 'all' : groupFilter} searching={!!query} archived={view === 'archived'} onArchive={project => void changeArchive(project)} onStar={project => void changeStar(project)} disabled={busy || !!pending || leave.busy || !!leave.pending || !identity.ready || !!shown?.error} />}
    </div>
    {page && !showGroups && <div className="project-directory-empty"><p>{query ? 'No projects on this page match your search.' : first && !page.next ? view === 'archived' ? '' : 'No current projects.' : `No ${view} projects on this page.`}</p>{!query && (view === 'archived' ? first && !page.next ? <div className="k42-empty-row"><span className="k42-empty-row-icon" aria-hidden="true"><Archive size={18} /></span><div><strong>Nothing archived.</strong><span>Archive a project from its ··· menu. Restore it any time.</span></div></div> : null : first && !page.next
      ? <EmptyState icon={MessageSquare} size="large" title="Start your first project from Claude" action={<Button className="primary" type="button" onClick={copyPrompt.copy}>{copyPrompt.copied ? 'Copied' : 'Copy the prompt'}</Button>}>Ask Claude, for example: “{CLAUDE_EXAMPLE_PROMPT}”</EmptyState>
      : null)}</div>}
    <Pager first={first} hasNext={!!page?.next} onBack={() => { setSearch(''); setPaging({ view, cursors: cursors.slice(0, -1) }); }} onNext={() => { if (page?.next) { setSearch(''); setPaging({ view, cursors: [...cursors, page.next] }); } }} nextLabel="More projects" />
  </ExploreLayout>;
}
