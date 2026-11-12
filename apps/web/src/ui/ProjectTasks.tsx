import { nativeTaskTitleMatches } from '@mlswarm/contracts';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { NativeTask, NativeTaskActor, NativeTaskDetail, NativeTaskStatus, NativeTaskActivity, NativeTaskSummary } from '@mlswarm/contracts';
import { closedTask } from '@mlswarm/contracts';
import { ArrowLeft, Check, ChevronDown, GitPullRequest, ChevronRight, Columns3, Filter, List, ListTodo, Plus, RefreshCw, Search, X } from 'lucide-react';
export type TaskAgent = { id: string; name: string; operatorId: string | null; operatorName: string | null; revokedAt: number | null;
  operatorPhoto?: import('@mlswarm/contracts').PublicProfilePhoto | null; personaChoice?: import('@mlswarm/contracts').PersonaChoice | null; assignable?: boolean;
  /** Live state and coding tool, known only for agents on the first full agents page. */
  state?: import('@mlswarm/contracts').CommunicationAgentState; provider?: string | null; focus?: import('@mlswarm/contracts').AgentFocus | null };
import { hold, projectRoute, taskRoute, type Route } from '../route';
import { NavLink } from '../navigation-link';
import type { PublicPhoto } from '../profile-photo-api';
import { TASK_STATUSES, isAccessLoss, isConflict, isTasksDisabled, isSettledRefusal, taskReferenceView, newestTaskSnapshot, taskSourceHref, taskReferenceFromUrl, statusLabel, statusChangeBlock, taskMutation, singleFlight, readTasksView, writeTasksView, nestTasks, taskFromPrompt, type TasksApi, type TasksView } from '../task-model';
import type { NativeTaskMutation } from '@mlswarm/contracts';
import { TaskAgentAvatar } from './TaskAgentAvatar';
import { TaskAgentHover, TaskContributorAvatars } from './TaskContributorAvatars';
import { PersonAvatar } from './PersonAvatar';
import { Button } from './Button';
import { CloseButton } from './CloseButton';
import { Dialog } from './Dialog';
import { EmptyState } from './EmptyState';
import { useLabelLookup } from '../label-lookup';
import { relativeTime } from '../observation-time';
import './segments.css';
import './project-tasks.css';

export type TaskPerson = { id: string; name: string | null; photo?: PublicPhoto | null; character?: import('@mlswarm/contracts').PersonCharacter | null };
/** Labels by id for actors the directory walks have not reached (at most 60 ids per call). */
export type TaskLabelLookup = { agents: (ids: string[]) => Promise<TaskAgent[]>; members: (ids: string[]) => Promise<TaskPerson[]> };
export interface ProjectTasksProps {
  api: TasksApi;
  /** Project agents: the only possible assignees. Revoked agents still label old tasks but cannot be picked. */
  agents: TaskAgent[];
  people: TaskPerson[];
  /** Closed project or hosted observation: reads only, no mutation controls. */
  readOnly?: boolean;
  active: boolean;
  /** The signed-in person's actor id: only their own comments offer Edit (the server enforces authorship). */
  selfId?: string | null;
  /** The signed-in person is the project owner: they may change any task's status (the server enforces this). */
  manager?: boolean;
  /** Same-project navigation for native conversation/message links. */
  projectId?: string;
  go?: (to: Route) => void;
  /** Tasks are turned off for this project: retained records stay readable, nothing can change. */
  disabledNotice?: boolean;
  /** Bumped by the sidebar's New task button: each new value opens the New task dialog. */
  createRequest?: number;
  /** The task page open in the URL (owner decision, 11 November 2026: a task opens as its own page with Back, not a drawer). */
  taskId?: string | null;
  viewerUrl?: string;
  lookup?: TaskLabelLookup;
}

const errorText = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong.';
// Task times read as "5 minutes ago"; the exact time shows on hover (owner, 12 November 2026).
const when = (at: number) => <time dateTime={new Date(at).toISOString()} title={new Date(at).toLocaleString()}>{relativeTime(at)}</time>;
const safeStorage = (): Storage | null => { try { return window.localStorage; } catch { return null; } };

// The walked directories label most actors. Actors shown on screen that a bounded walk has not reached are looked up
// by id, so a large project still names its assignees, contributors and authors, including retired agents.
function useDirectory(agents: TaskAgent[], people: TaskPerson[], shown: NativeTaskActor[], lookup?: TaskLabelLookup) {
  const walkedAgents = useMemo(() => new Map(agents.map(a => [a.id, a])), [agents]);
  const walkedPeople = useMemo(() => new Map(people.map(p => [p.id, p])), [people]);
  const looked = {
    agents: useLabelLookup(lookup?.agents ?? null, 'agents', shown.filter(a => a.kind === 'agent').map(a => a.id), walkedAgents),
    people: useLabelLookup(lookup?.members ?? null, 'members', shown.filter(a => a.kind === 'person').map(a => a.id), walkedPeople),
  };
  return useMemo(() => {
    const agent = looked.agents.rows, person = looked.people.rows;
    const name = (actor: NativeTaskActor) => actor.kind === 'agent' ? agent.get(actor.id)?.name ?? 'Agent' : person.get(actor.id)?.name ?? 'Member';
    // Without a lookup, an agent the walk never listed is taken as gone, as before.
    const gone = (id: string) => { const row = agent.get(id); return row ? row.revokedAt != null : !lookup || looked.agents.absent.has(id); };
    return { agent, person, name, gone };
  }, [looked.agents, looked.people, lookup]);
}
type Directory = ReturnType<typeof useDirectory>;

function AgentChip({ id, directory, size = 28 }: { id: string; directory: Directory; size?: number }) {
  const row = directory.agent.get(id);
  return <span className="k42-task-actor">
    <TaskAgentAvatar id={id} name={row?.name ?? 'Agent'} agent={row} size={size} />
    <span>{row?.name ?? 'Agent'}{row?.revokedAt != null && <span className="muted"> (removed)</span>}</span>
  </span>;
}
function ActorChip({ actor, directory }: { actor: NativeTaskActor; directory: Directory }) {
  if (actor.kind === 'agent') return <AgentChip id={actor.id} directory={directory} size={24} />;
  const person = directory.person.get(actor.id);
  return <span className="k42-task-actor"><PersonAvatar id={actor.id} name={person?.name ?? null} photo={person?.photo} character={person?.character} size={24} /><span>{directory.name(actor)}</span></span>;
}
function Unassigned() { return <span className="k42-task-actor k42-task-unassigned"><span className="k42-task-unassigned-dot" aria-hidden="true" />Unassigned</span>; }

function SubtaskRing({ done, total }: { done: number; total: number }) {
  if (!total) return null;
  const r = 7, c = 2 * Math.PI * r;
  return <span className="k42-subtask-ring" title={`${done} of ${total} subtasks done or canceled`}>
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r={r} className="k42-subtask-ring-track" />
      <circle cx="9" cy="9" r={r} className="k42-subtask-ring-fill" strokeDasharray={`${c * done / total} ${c}`} transform="rotate(-90 9 9)" /></svg>
    <span aria-hidden="true">{done}/{total}</span><span className="k42-visually-hidden">{done} of {total} subtasks closed</span>
  </span>;
}
function Proposed() { return <span className="k42-task-proposed">Proposed</span>; }

/** The selected simple design: one task per row (title, assigned agent, contributing agents, status, latest update); a task opens as its own page. */
export function ProjectTasks({ api, agents, people, readOnly = false, active, selfId = null, manager = false, projectId, go, disabledNotice = false, createRequest = 0, taskId = null, viewerUrl, lookup }: ProjectTasksProps) {
  const [searchDraft, setSearchDraft] = useState(''), [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [assignee, setAssignee] = useState('');
  const assignedAgentId = assignee === 'unassigned' ? null : assignee ? assignee.slice(6) : undefined;
  const [view, setView] = useState<TasksView>(() => readTasksView(safeStorage()));
  const chooseView = (next: TasksView) => { setView(next); writeTasksView(safeStorage(), next); };
  // On the board the columns are the states, so the State filter is hidden and not applied there.
  const [statusChoice, setStatus] = useState<NativeTaskStatus | ''>('');
  const status = view === 'board' ? '' : statusChoice;
  const [tasks, setTasks] = useState<NativeTask[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // In the app the open task lives in the URL, so Back/Forward and reloads keep it; without navigation it is local state.
  const [localOpen, setLocalOpen] = useState<string | null>(null);
  const routed = !!go && !!projectId;
  const openId = routed ? taskId : localOpen;
  const setOpenId = useCallback((id: string | null) => {
    if (routed) go!(id ? taskRoute(projectId!, id) : projectRoute(projectId!)); else setLocalOpen(id);
  }, [routed, go, projectId]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) => setCollapsed(current => { const next = new Set(current); if (!next.delete(id)) next.add(id); return next; });
  const [creating, setCreating] = useState(false);
  useEffect(() => { if (createRequest > 0) setCreating(true); }, [createRequest]);
  const [drawerActors, setDrawerActors] = useState<NativeTaskActor[]>([]);
  const shown = useMemo(() => [...(tasks ?? []).flatMap(task => [...task.assignedAgentId ? [{ kind: 'agent' as const, id: task.assignedAgentId }] : [], ...task.contributors]),
    ...openId ? drawerActors : []], [tasks, openId, drawerActors]);
  const directory = useDirectory(agents, people, shown, active ? lookup : undefined);
  // Only the latest load may write; a reply from an earlier account or project is dropped.
  const generation = useRef(0), pageCursors = useRef<(string | null)[]>([null]);
  const load = useCallback(() => {
    const mine = ++generation.current, count = pageCursors.current.length;
    void (async () => {
      const cursors: (string | null)[] = [], rows: NativeTask[] = [];
      let cursor: string | null = null;
      // Rebuild the loaded range from returned cursors: inserts and larger records can move page boundaries.
      for (let index = 0; index < count; index++) {
        cursors.push(cursor);
        const page = await api.list(cursor, status || undefined, assignedAgentId, search || undefined);
        rows.push(...page.tasks); cursor = page.nextCursor;
        if (!cursor) break;
      }
      if (mine !== generation.current) return;
      pageCursors.current = cursors;
      setTasks(current => {
        const saved = new Map(current?.map(task => [task.id, task]));
        return rows.map(task => newestTaskSnapshot(saved.get(task.id), task));
      });
      setNext(cursor); setError(null);
    })().catch(e => {
      if (mine !== generation.current) return;
      if (isAccessLoss(e)) { setTasks(null); setNext(null); setLocalOpen(null); setCreating(false); }
      setError(errorText(e));
    });
  }, [api, status, assignedAgentId, search]);
  useEffect(() => { pageCursors.current = [null]; setTasks(null); setNext(null); setError(null); return () => { generation.current++; }; }, [api, status, assignedAgentId]);
  // A new search keeps the current rows on screen until its first page replaces them, so typing does not flash the table.
  useEffect(() => { pageCursors.current = [null]; return () => { generation.current++; }; }, [search]);
  // Search as you type: the latest text applies after a short pause; Enter applies it at once.
  useEffect(() => {
    const value = searchDraft.trim();
    if (value === search) return;
    const timer = setTimeout(() => { generation.current++; setSearch(value); }, value ? 250 : 0);
    return () => clearTimeout(timer);
  }, [searchDraft, search]);
  // "/" opens the list's search unless the person is already typing somewhere.
  useEffect(() => {
    if (!active || view !== 'list' || openId) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey || target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      event.preventDefault(); setSearchOpen(true);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [active, view, openId]);
  useEffect(() => {
    if (!active) return;
    const refresh = () => { if (document.visibilityState !== 'hidden') load(); };
    refresh();const timer=setInterval(refresh,10_000);window.addEventListener('focus',refresh);
    return()=>{clearInterval(timer);window.removeEventListener('focus',refresh);};
  }, [active, load]);
  // One page request at a time; a reply for an earlier account, project or refresh is dropped, including its error.
  const [loadingGeneration, setLoadingGeneration] = useState<number | null>(null);
  const loadingMore = loadingGeneration === generation.current;
  const moreFlight = useRef(singleFlight()).current;
  const more = () => { const mine = generation.current; if (!next || !moreFlight.start(mine)) return; setLoadingGeneration(mine);
    api.list(next, status || undefined, assignedAgentId, search || undefined).then(page => { if (mine !== generation.current) return; pageCursors.current.push(next); setTasks(t => [...(t ?? []), ...page.tasks.filter(n => !t?.some(o => o.id === n.id))]); setNext(page.nextCursor); },
      e => { if (mine === generation.current) setError(errorText(e)); }).finally(() => { if (moreFlight.end(mine)) setLoadingGeneration(current => current === mine ? null : current); }); };
  const replace = (task: NativeTask) => {
    setTasks(current => {
      const saved = current?.find(row => row.id === task.id);
      const newest = newestTaskSnapshot(saved, task);
      if (!nativeTaskTitleMatches(newest.title, search) || (status && newest.status !== status) || (assignedAgentId !== undefined && newest.assignedAgentId !== assignedAgentId)) return current?.filter(row => row.id !== task.id) ?? null;
      return saved ? current!.map(row => row.id === task.id ? newest : row) : [newest, ...(current ?? [])];
    });
    load();
  };
  const assignable = agents.filter(a => a.revokedAt === null && a.assignable !== false);

  const filterAgents = new Map(agents.map(agent => [agent.id, agent.name]));
  for (const [id, row] of directory.agent) if (!filterAgents.has(id)) filterAgents.set(id, row.name);
  for (const task of tasks ?? []) if (task.assignedAgentId && !filterAgents.has(task.assignedAgentId)) filterAgents.set(task.assignedAgentId, `Agent (${task.assignedAgentId})`);
  if (assignedAgentId && !filterAgents.has(assignedAgentId)) filterAgents.set(assignedAgentId, `Agent (${assignedAgentId})`);

  // Titles keep a toggle column only when some row can expand, so the header and every title line up.
  const rows = tasks ? nestTasks(tasks, collapsed) : [], toggles = rows.some(row => row.children.length > 0);
  const submitSearch = (event: FormEvent) => { event.preventDefault(); const value = searchDraft.trim(); if (value === search) load(); else { generation.current++; setSearch(value); } };
  const clearSearch = () => { setSearchDraft(''); setSearchOpen(false); if (search) { generation.current++; setSearch(''); } };
  const searchField = (header: boolean) => <form className={header ? 'k42-th-search' : 'k42-tasks-search'} role="search" aria-label="Task titles" onSubmit={submitSearch}>
    <Search className="k42-tasks-search-icon" size={header ? 14 : 16} aria-hidden="true" />
    <input type="search" aria-label="Search tasks" value={searchDraft} maxLength={300} placeholder="Search tasks" autoFocus={header && !searchDraft}
      onChange={event => setSearchDraft(event.target.value)} onKeyDown={event => { if (header && event.key === 'Escape') { event.preventDefault(); clearSearch(); } }}
      onBlur={() => { if (header && !searchDraft.trim()) setSearchOpen(false); }} />
    {header && <button type="button" className="k42-th-clear" aria-label="Close search" onClick={clearSearch}><X size={14} aria-hidden="true" /></button>}
  </form>;
  // A header filter is the column's name over a native select: it reads like a header, the browser's own picker opens, and the value shows when set.
  const headerFilter = (label: string, value: string, shownValue: string | null, select: ReactNode) => <span className={`k42-th-filter${value ? ' is-active' : ''}`}>
    <span className="k42-th-filter-label" aria-hidden="true">{label}{shownValue && <span className="k42-th-filter-value">{shownValue}</span>}<Filter size={13} className="k42-th-filter-icon" fill={value ? 'currentColor' : 'none'} /></span>
    {select}
  </span>;
  const stateFilter = (header: boolean) => {
    const select = <select className={header ? 'k42-th-select' : 'k42-tasks-filter'} aria-label="State" value={statusChoice} onChange={event => { generation.current++; setStatus(event.target.value as NativeTaskStatus | ''); }}>
      <option value="">All states</option>
      {TASK_STATUSES.map(state => <option key={state.id} value={state.id}>{state.label}</option>)}
    </select>;
    return header ? headerFilter('Status', statusChoice, statusChoice ? statusLabel(statusChoice) : null, select) : select;
  };
  const assigneeFilter = (header: boolean) => {
    const select = <select className={header ? 'k42-th-select' : 'k42-tasks-filter'} aria-label="Owner" value={assignee} onChange={event => { generation.current++; setAssignee(event.target.value); }}>
      <option value="">All assignments</option>
      <option value="unassigned">Unassigned</option>
      {[...filterAgents].map(([id, name]) => <option key={id} value={`agent:${id}`}>{name}</option>)}
    </select>;
    return header ? headerFilter('Owner', assignee, assignee === 'unassigned' ? 'Unassigned' : assignedAgentId ? filterAgents.get(assignedAgentId) ?? 'Agent' : null, select) : select;
  };

  if (openId) return <section className="k42-tasks">
    <TaskPage key={openId} api={api} taskId={openId} directory={directory} agents={assignable} readOnly={readOnly} onActors={setDrawerActors} onChange={replace} onAccessLost={load} onOpen={setOpenId} selfId={selfId} projectId={projectId} go={go} viewerUrl={viewerUrl} />
  </section>;

  return <section className="k42-tasks" aria-labelledby="k42-tasks-title">
    <div className="k42-tasks-head">
      <h2 id="k42-tasks-title" className="k42-section-title">Tasks{tasks && <span className="k42-tasks-heading-count"> ({tasks.length}{next ? '+' : ''})</span>}</h2>
      {/* Refresh and New task sit beside List/Board; the list's filters live in its column headers (owner, 11 November 2026). */}
      <div className="k42-tasks-head-actions">
        <Button className="k42-tasks-refresh" onClick={load} aria-label="Refresh tasks" title="Refresh tasks"><RefreshCw size={16} aria-hidden="true" /></Button>
        {!readOnly && <Button className="k42-tasks-new" onClick={() => setCreating(true)}><Plus size={18} aria-hidden="true" />New task</Button>}
        <div className="k42-task-segments k42-tasks-view" role="group" aria-label="Tasks view">
          <button type="button" className="k42-task-segment" aria-pressed={view === 'list'} onClick={() => chooseView('list')}><List size={16} aria-hidden="true" />List</button>
          <button type="button" className="k42-task-segment" aria-pressed={view === 'board'} onClick={() => chooseView('board')}><Columns3 size={16} aria-hidden="true" />Board</button>
        </div>
      </div>
    </div>
    {/* The board has no headers, and narrow screens hide them, so a slim bar carries the same filters there. */}
    <div className={`k42-tasks-toolbar${view === 'list' ? ' is-narrow-only' : ''}`}>
      {searchField(false)}
      {view === 'list' && stateFilter(false)}
      {assigneeFilter(false)}
    </div>
    {disabledNotice ? <p className="muted" role="status">Tasks are off. Existing tasks are read-only.</p>
      : readOnly && <p className="muted">This view is read-only.</p>}
    {creating && !readOnly && <NewTask api={api} agents={assignable.filter(agent => manager || (!!selfId && agent.operatorId === selfId))}
      onCancel={() => setCreating(false)} onCreated={task => { replace(task); setCreating(false); setOpenId(task.id); }} />}
    {error && <div role="alert" className="k42-tasks-error"><p>Could not load tasks: {error}</p><Button onClick={load}>Try again</Button></div>}
    {!tasks && !error && <p className="muted" role="status">Loading tasks…</p>}
    {!!tasks?.length && view === 'board' && <TasksBoard api={api} tasks={tasks} directory={directory} readOnly={readOnly} more={!!next}
      canMove={task => !readOnly && (manager || (!!selfId && !!task.assignedAgentId && directory.agent.get(task.assignedAgentId)?.operatorId === selfId))}
      onOpen={setOpenId} onChange={replace} onReload={load} />}
    {!!tasks && (tasks.length > 0 || !!(search || assignee || status)) && view === 'list' && <div className="k42-tasks-tablewrap"><table className="k42-tasks-table">
      <thead><tr>
        <th scope="col" className={`k42-th-task${toggles ? ' has-toggles' : ''}`}>{searchOpen || searchDraft ? searchField(true)
          : <button type="button" className="k42-th-filter k42-th-search-open" aria-label="Task · search tasks" title="Search tasks (/)" onClick={() => setSearchOpen(true)}>Task<Search size={13} className="k42-th-filter-icon" aria-hidden="true" /></button>}</th>
        <th scope="col">{assigneeFilter(true)}</th><th scope="col">Agents</th><th scope="col">{stateFilter(true)}</th><th scope="col">Updated</th></tr></thead>
      <tbody>{rows.map(({ task, depth, children }) => <tr key={task.id} className={depth ? 'is-subtask' : undefined}>
        <th scope="row"><div className="k42-task-cell" style={{ ['--depth' as string]: depth }}>
          {children.length ? <button type="button" className="k42-task-toggle" aria-expanded={!collapsed.has(task.id)} onClick={() => toggle(task.id)}
            aria-label={`${collapsed.has(task.id) ? 'Show' : 'Hide'} subtasks of ${task.title}`}>{collapsed.has(task.id) ? <ChevronRight size={16} aria-hidden="true" /> : <ChevronDown size={16} aria-hidden="true" />}</button>
            : toggles && <span className="k42-task-toggle-space" aria-hidden="true" />}
          <button type="button" className="k42-task-open" title={task.title} onClick={() => setOpenId(task.id)}>{task.title}</button>
          {task.proposed && <Proposed />}
          {task.priority === 'high' && <span className="k42-task-priority">High</span>}
          {task.subtaskProgress && <SubtaskRing {...task.subtaskProgress} />}</div></th>
        <td data-label="Assigned">{task.assignedAgentId ? <TaskAgentHover id={task.assignedAgentId} agents={directory.agent} /> : <Unassigned />}</td>
        <td data-label="Agents"><TaskContributorAvatars contributors={task.contributors} agents={directory.agent} /></td>
        <td data-label="Status"><span className={`k42-task-status is-${task.status}`}>{statusLabel(task.status)}</span></td>
        <td data-label="Updated" className="muted">{when(task.updatedAt)}</td>
      </tr>)}</tbody>
    </table></div>}
    {/* No tasks at all gets the large empty state, like other empty pages (owner, 11 November 2026); filtered results stay small. */}
    {tasks?.length === 0 && !creating && (next || search || assignee || status
      ? <EmptyState icon={ListTodo} tone={null} title={next ? 'More tasks to search' : search || assignee || !status ? 'No tasks match these filters' : `No ${statusLabel(status).toLowerCase()} tasks`}>{next ? 'No matches in this page. Show more to continue searching.' : 'Change the title search, state or assigned agent filter to see more tasks.'}</EmptyState>
      : <EmptyState icon={ListTodo} size="large" title="No tasks yet" action={!readOnly && <Button className="primary" onClick={() => setCreating(true)}><Plus size={18} aria-hidden="true" />New task</Button>}>{readOnly ? 'Tasks will appear here.' : 'Add the first task. A title is enough; an agent can pick it up from Backlog.'}</EmptyState>)}
    {next && <Button onClick={more} disabled={loadingMore}>{loadingMore ? 'Loading…' : 'Show more'}</Button>}
  </section>;
}

function NewTask({ api, agents, onCreated, onCancel }: { api: TasksApi; agents: TaskAgent[]; onCreated: (task: NativeTask) => void; onCancel: () => void }) {
  const [text, setText] = useState(''), [agentId, setAgentId] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [uncertain, setUncertain] = useState(false);
  // One request ID per draft: retrying after an uncertain response cannot create a second task.
  const requestId = useRef(crypto.randomUUID()), titleId = useId(), textId = useId(), agentFieldId = useId();
  const created = useRef<NativeTask | null>(null), dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (dialog.current && !dialog.current.open) dialog.current.showModal(); }, []);
  // A task created before a failed assignment still shows in the list when the dialog closes.
  const close = () => { if (busy) return; if (created.current) onCreated(created.current); else onCancel(); };
  // Assigning is a second step on the created task; if it fails the task stays, unassigned in Backlog.
  const assign = (task: NativeTask) => api.mutate(taskMutation({ operation: 'assign', taskId: task.id, expectedRevision: task.revision, assignedAgentId: agentId }))
    .then(result => onCreated(result.task), e => { setError(`The task was created, but it could not be assigned: ${errorText(e)}`); setBusy(false); });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true); setError(null);
    if (created.current) { void assign(created.current); return; }
    const { title, description } = taskFromPrompt(text);
    api.mutate(taskMutation({ operation: 'create', title, ...description ? { description } : {} }, requestId.current))
      .then(result => { created.current = result.task; if (agentId) void assign(result.task); else onCreated(result.task); }, e => {
        // A refused create may be corrected and sent as a new request; an unknown outcome is retried unchanged.
        const settled = isSettledRefusal(e);
        if (settled) requestId.current = crypto.randomUUID();
        setUncertain(!settled); setError(settled ? errorText(e) : 'Could not confirm the task was created. Retry sends the same request; it will not create a duplicate.'); setBusy(false);
      });
  };
  const locked = uncertain || !!created.current;
  return <Dialog ref={dialog} className="k42-task-dialog" aria-labelledby={`${titleId}-heading`} onCancel={e => { e.preventDefault(); close(); }}>
    <CloseButton label="Close new task" onClick={close} disabled={busy} />
    <form className="k42-task-new" onSubmit={submit}>
      <h2 id={`${titleId}-heading`}>New task</h2>
      <label htmlFor={textId} className="visually-hidden">What should be done?</label>
      <textarea id={textId} className="k42-task-textarea" value={text} readOnly={locked} onChange={e => setText(e.target.value)} autoFocus required maxLength={10000} rows={5}
        placeholder="What should be done? The first line becomes the task's title."
        onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }} />
      {/* Assign to is a row of agent avatars, not a dropdown; hovering one shows who it is, clicking the chosen one again unassigns (owner, 11 November 2026). */}
      {agents.length > 0 && <fieldset className="k42-task-assignees" aria-describedby={agentFieldId}>
        <legend>Assign to <span className="muted">(optional)</span></legend>
        <div className="k42-task-assignee-row">{agents.map(agent => {
          const chosen = agentId === agent.id;
          return <button key={agent.id} type="button" className="k42-task-assignee" aria-pressed={chosen} aria-label={agent.operatorName ? `${agent.name}, agent of ${agent.operatorName}` : agent.name}
            onClick={() => setAgentId(chosen ? '' : agent.id)}>
            <TaskAgentAvatar id={agent.id} name={agent.name} agent={agent} size={40} hideState={chosen} />
            {chosen && <span className="k42-task-assignee-check" aria-hidden="true"><Check size={12} /></span>}
            <span className="k42-task-assignee-tip" aria-hidden="true"><strong>{agent.name}</strong>{agent.operatorName && <span>Agent of {agent.operatorName}</span>}<span>{chosen ? 'Click to unassign' : 'Click to assign'}</span></span>
          </button>;
        })}</div>
      </fieldset>}
      <p className="muted" id={agentFieldId}>{agentId ? `${agents.find(agent => agent.id === agentId)?.name ?? 'The agent'} finds it in Backlog, assigned to it.` : 'New tasks start unassigned in Backlog.'}</p>
      {error && <p role="alert" className="error">{error}</p>}
      <div className="k42-task-actions"><Button type="submit" className="primary" disabled={busy || !text.trim()}>{busy ? 'Adding…' : created.current ? 'Retry assigning' : uncertain ? 'Retry' : 'Add'}</Button><Button type="button" onClick={close} disabled={busy}>Cancel</Button></div>
    </form>
  </Dialog>;
}

/** Board view: one column per task status, in the existing order, over the same loaded tasks as the list, flat (subtasks are cards too).
 *  A card shows title, assigned agent and state; opening it opens the task page. Dropping a card on another column sends the page's
 *  status change (`update` with the revision it saw). Like the page's status buttons, only a person who may change the task's status (the owner, or the person of its
 *  assigned agent) can drag it; the server keeps its control and transition rules, and a refusal is shown here without changing anything. */
function TasksBoard({ api, tasks, directory, readOnly, more, canMove, onOpen, onChange, onReload }: {
  api: TasksApi; tasks: NativeTask[]; directory: Directory; readOnly: boolean; more: boolean; canMove: (task: NativeTask) => boolean; onOpen: (id: string) => void; onChange: (task: NativeTask) => void; onReload: () => void;
}) {
  const [dragging, setDragging] = useState<string | null>(null), [over, setOver] = useState<NativeTaskStatus | null>(null);
  const [moving, setMoving] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const dragged = dragging ? tasks.find(task => task.id === dragging) ?? null : null;
  const accepts = (status: NativeTaskStatus) => !!dragged && canMove(dragged) && dragged.status !== status && !statusChangeBlock(dragged, status);
  const drop = (status: NativeTaskStatus) => {
    const task = dragged; setDragging(null); setOver(null);
    if (!task || moving || readOnly || !canMove(task)) return;
    const blocked = statusChangeBlock(task, status);
    if (blocked) { setNotice(`${blocked}.`); return; }
    if (task.status === status) return;
    setMoving(task.id); setNotice(null);
    api.mutate(taskMutation({ operation: 'update', taskId: task.id, expectedRevision: task.revision, status })).then(result => onChange(result.task), e => {
      if (isConflict(e)) setNotice('Someone else changed this task first. The board shows the latest saved state.');
      else if (isTasksDisabled(e)) setNotice('Tasks were turned off for this project. Nothing was changed.');
      else if (isSettledRefusal(e)) setNotice(`Could not move “${task.title}”: ${errorText(e)}`);
      else setNotice(`Could not confirm the move of “${task.title}”. The board shows the latest saved state.`);
      onReload();
    }).finally(() => setMoving(current => current === task.id ? null : current));
  };
  return <div className="k42-tasks-board-wrap">
    {!readOnly && <p className="muted k42-tasks-board-hint">Drag a card to another column, or open it to change its status.</p>}
    {notice && <div role="status" className="k42-task-notice k42-tasks-board-notice"><p>{notice}</p><Button onClick={() => setNotice(null)} aria-label="Dismiss">Dismiss</Button></div>}
    <div className="k42-tasks-board" role="list" aria-label="Tasks by status">
      {TASK_STATUSES.map(state => {
        const column = tasks.filter(task => task.status === state.id);
        const target = accepts(state.id);
        return <section key={state.id} role="listitem" aria-label={state.label} className={`k42-tasks-column is-${state.id}${over === state.id && dragged?.status !== state.id ? target ? ' is-over' : ' is-refused' : ''}`}
          onDragOver={event => { if (!dragged || readOnly) return; event.preventDefault(); event.dataTransfer.dropEffect = 'move'; if (over !== state.id) setOver(state.id); }}
          onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(current => current === state.id ? null : current); }}
          onDrop={event => { event.preventDefault(); drop(state.id); }}>
          <h3 className="k42-tasks-column-head"><span className={`k42-task-status is-${state.id}`}>{state.label}</span><span className="k42-tasks-count">{column.length}{more ? '+' : ''}</span></h3>
          <ul className="k42-tasks-cards">
            {column.map(task => <li key={task.id} className={`k42-tasks-card${dragging === task.id ? ' is-dragging' : ''}${moving === task.id ? ' is-moving' : ''}`}
              draggable={!moving && canMove(task)} aria-busy={moving === task.id || undefined}
              onDragStart={event => { if (!canMove(task)) { event.preventDefault(); return; } event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', task.id); setDragging(task.id); }}
              onDragEnd={() => { setDragging(null); setOver(null); }}>
              <button type="button" className="k42-task-open k42-tasks-card-title" onClick={() => onOpen(task.id)}>{task.title}</button>
              {task.proposed && <Proposed />}
              {task.priority === 'high' && <span className="k42-task-priority">High</span>}
              <div className="k42-tasks-card-meta">
                {task.assignedAgentId ? <TaskAgentHover id={task.assignedAgentId} agents={directory.agent} size={24} /> : <Unassigned />}
                <span className={`k42-task-status is-${task.status}`}>{statusLabel(task.status)}</span>
              </div>
            </li>)}
          </ul>
          {!column.length && <p className="muted k42-tasks-column-empty">{dragged && !readOnly ? target ? 'Drop here' : statusChangeBlock(dragged, state.id) ?? 'Already here' : 'No tasks'}</p>}
        </section>;
      })}
    </div>
  </div>;
}


/**
 * One task, read top to bottom (owner decision, 12 November 2026): title, one row of chips (status, owner, agents,
 * priority, links), the description, subtasks and one activity feed. Title, description and comments are not edited here.
 */
function TaskPage({ api, taskId, directory, agents, readOnly: readOnlyProp, onActors, onChange, onAccessLost, onOpen, selfId, projectId, go, viewerUrl }: {
  api: TasksApi; taskId: string; directory: Directory; agents: TaskAgent[]; readOnly: boolean; onActors: (actors: NativeTaskActor[]) => void; onChange: (task: NativeTask) => void; onAccessLost: () => void; onOpen: (id: string | null) => void;
  selfId: string | null; projectId?: string; go?: (to: Route) => void; viewerUrl?: string;
}) {
  const [detail, setDetail] = useState<NativeTaskDetail | null>(null);
  const [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const [comment, setComment] = useState(''), [link, setLink] = useState(''), [linkLabel, setLinkLabel] = useState(''), [linkOpen, setLinkOpen] = useState(false);
  // A write whose outcome is unknown (lost reply, network, 5xx) is kept and resent byte-for-byte until it settles.
  const [uncertain, setUncertain] = useState<NativeTaskMutation | null>(null);
  const [turnedOff, setTurnedOff] = useState(false);
  const readOnly = readOnlyProp || turnedOff || detail?.permissions.edit === false;
  const draftState=useRef({dirty:false,busy:false});draftState.current={dirty:!!comment.trim() || !!link.trim() || !!linkLabel.trim(),busy:busy || !!uncertain};
  // A typed comment or link and a change awaiting its exact retry hold the page and survive an accidental close.
  const unsaved=draftState.current.dirty || draftState.current.busy;
  useEffect(()=>unsaved ? hold() : undefined,[unsaved]);
  const leave=(to:string|null)=>{ if(!draftState.current.dirty && !draftState.current.busy || window.confirm('Discard your unsaved changes to this task?')) onOpen(to); };
  const linkDraft = useRef({ link, label: linkLabel }); linkDraft.current = { link, label: linkLabel };
  const revision=useRef(0);revision.current=detail?.task.revision ?? 0;
  const titleId = useId(), panel = useRef<HTMLElement>(null);
  // Replies for an earlier api (account/profile) or a left page are dropped.
  const live = useRef(api); live.current = api;
  useEffect(() => { live.current = api; return () => { live.current = null as unknown as TasksApi; }; }, [api]);
  const current = (from: TasksApi) => live.current === from;
  const reload = useCallback(() => { const from = api; return api.get(taskId,{activityOrder:'desc'}).then(d => { if (!current(from)) return; if (d.task.revision < revision.current) return;
      setDetail(current => current && current.task.revision > d.task.revision ? current : {...d,activity:[...d.activity].sort((a,b)=>a.revision-b.revision)}); onChange(d.task); setError(null); }, e => {
    if (!current(from)) return;
    if (isAccessLoss(e)) { setDetail(null); onAccessLost(); }
    setError(errorText(e));
  }); }, [api, taskId]);
  useEffect(() => { setDetail(null); }, [api]);
  // Comment authors and history actors are labelled like task rows.
  useEffect(() => { onActors(detail ? [...detail.comments.map(c => c.author), ...detail.activity.map(a => a.actor)] : []); }, [detail]);
  /** After a confirmed write, fetch the authoritative newest history without dropping older loaded pages or drafts. */
  const refreshActivity = () => { const from = api; api.get(taskId, { activityOrder: 'desc' }).then(d => { if (!current(from)) return;
    setDetail(cur => {
      if (!cur || cur.task.revision > d.task.revision) return cur;
      const comments = new Map(cur.comments.map(comment => [comment.id, comment]));
      for (const comment of d.comments) if ((comments.get(comment.id)?.updatedAt ?? -1) <= comment.updatedAt) comments.set(comment.id, comment);
      return { ...cur, task: newestTaskSnapshot(cur.task, d.task), permissions:d.permissions,
        comments: [...comments.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
        activity: [...d.activity, ...cur.activity.filter(a => !d.activity.some(n => n.id === a.id))].sort((a, b) => a.revision - b.revision) };
    }); onChange(d.task); },
    e => { if (current(from) && isAccessLoss(e)) { setDetail(null); setError(errorText(e)); onAccessLost(); } }); };
  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => {
    const refresh=()=>{if(document.visibilityState!=='hidden' && !draftState.current.busy)void reload();};
    const timer=setInterval(refresh,10_000);window.addEventListener('focus',refresh);
    return()=>{clearInterval(timer);window.removeEventListener('focus',refresh);};
  }, [reload]);
  /** Older comments and history append (deduplicated) and keep the current task record. */
  const more = (which: 'comments' | 'activity') => {
    if (!detail) return;
    const cursors = which === 'comments' ? { commentCursor: detail.nextCommentCursor } : { activityCursor: detail.nextActivityCursor };
    const from = api;
    api.get(taskId, {...cursors,activityOrder:'desc'}).then(page => current(from) && setDetail(d => d && (which === 'comments'
      ? { ...d, comments: [...d.comments, ...page.comments.filter(c => !d.comments.some(o => o.id === c.id))].sort((a,b)=>a.createdAt-b.createdAt || a.id.localeCompare(b.id)), nextCommentCursor: page.nextCommentCursor }
      : { ...d, activity: [...d.activity, ...page.activity.filter(a => !d.activity.some(o => o.id === a.id))].sort((a,b)=>a.revision-b.revision), nextActivityCursor: page.nextActivityCursor })),
    e => { if (!current(from)) return; if (isAccessLoss(e)) { setDetail(null); onAccessLost(); } setNotice(errorText(e)); });
  };
  // Opening a task page moves focus to its heading, like other page changes.
  useEffect(() => { panel.current?.focus(); }, []);
  const task = detail?.task;
  type Op = Parameters<typeof taskMutation>[0];
  /** Each write sends the revision it saw; a 409 reloads the latest task and keeps any typed comment or link. */
  const send = (mutation: NativeTaskMutation) => {
    setBusy(true); setNotice(null);
    const from = api;
    return api.mutate(mutation).then(result => {
      if (!current(from)) return false;
      setUncertain(null);
      // A confirmed write (including an identical Retry replay) settles only its own draft; newer typing is kept.
      if (mutation.operation === 'comment') setComment(draft => draft.trim() === mutation.body ? '' : draft);
      if (mutation.operation === 'add_reference') {
        const draft = linkDraft.current;
        try {
          const reference = taskReferenceFromUrl(draft.link, mutation.reference.id, projectId, viewerUrl ?? new URL('/', window.location.href).href, draft.label);
          const same = reference.kind === mutation.reference.kind && reference.label === mutation.reference.label
            && ('url' in reference && 'url' in mutation.reference ? reference.url === mutation.reference.url
              : 'sourceId' in reference && 'sourceId' in mutation.reference && reference.sourceId === mutation.reference.sourceId);
          if (same) { setLink(value => value === draft.link ? '' : value); setLinkLabel(value => value === draft.label ? '' : value); setLinkOpen(false); }
        } catch { /* A newer incomplete draft is unrelated to this successful write. */ }
      }
      setDetail(d => d && { ...d, task: newestTaskSnapshot(d.task, result.task), comments: result.comment ? [...d.comments.filter(c => c.id !== result.comment!.id), d.comments.find(c => c.id === result.comment!.id && c.updatedAt > result.comment!.updatedAt) ?? result.comment].sort((a,b)=>a.createdAt-b.createdAt || a.id.localeCompare(b.id)) : d.comments });
      onChange(result.task); refreshActivity(); return true;
    }, e => {
      if (!current(from)) return false;
      if (!isSettledRefusal(e)) { setUncertain(mutation); setNotice('Could not confirm this change. Retry sends the same change again; it will not be applied twice.'); return false; }
      setUncertain(null);
      if (isTasksDisabled(e)) { setTurnedOff(true); setNotice('Tasks were turned off for this project. Nothing was changed; existing tasks stay readable.'); }
      else if (isConflict(e)) { setNotice('Someone else changed this task. This is the latest version; try again if you still want the change.'); void reload(); }
      else if (isAccessLoss(e)) { setDetail(null); setError(errorText(e)); onAccessLost(); }
      else setNotice(errorText(e));
      return false;
    }).finally(() => { if (current(from)) setBusy(false); });
  };
  const act = (op: Op) => !task || busy || uncertain || readOnly ? Promise.resolve(false) : send(taskMutation(op));
  const base = task ? { taskId: task.id, expectedRevision: task.revision } : null;
  const sendComment = (event: FormEvent) => {
    event.preventDefault();
    if (!base || !comment.trim()) return;
    void act({ operation: 'comment', ...base, body: comment.trim() });
  };
  const addLink = (event: FormEvent) => {
    event.preventDefault();
    if (!base) return;
    try { const reference=taskReferenceFromUrl(link,crypto.randomUUID(),projectId,viewerUrl ?? new URL('/',window.location.href).href,linkLabel);
      void act({operation:'add_reference',...base,reference});
    } catch(e){setNotice(errorText(e));}
  };
  const waiting = busy || !!uncertain;
  const canControl = detail?.permissions.control === true;
  const assignmentChoices=task?.status === 'canceled' ? [] : detail?.permissions.assign === 'any' ? agents : detail?.permissions.assign === 'own' ? agents.filter(a=>a.operatorId===selfId) : [];
  const parent = detail?.ancestors?.at(-1) ?? null, subtasks = detail?.subtasks ?? [];
  const face = (id: string) => <TaskAgentAvatar agent={directory.agent.get(id)} id={id} name={directory.name({ kind: 'agent', id })} size={28} />;
  const noOwner = <span className="muted">No owner</span>;
  return <article ref={panel} tabIndex={-1} className="k42-task-page" aria-labelledby={titleId}>
      <button type="button" className="k42-task-back" onClick={() => leave(parent?.id ?? null)}><ArrowLeft size={16} aria-hidden="true" />{parent ? parent.title : 'Back to Tasks'}</button>
      <h2 id={titleId}>{task?.title ?? 'Task'}</h2>
      {error && <div role="alert"><p className="error">Could not load this task: {error}</p><Button onClick={() => void reload()}>Try again</Button></div>}
      {!detail && !error && <p className="muted" role="status">Loading…</p>}
      {task && <>
        {notice && <div role="status" className="k42-task-notice"><p>{notice}</p>{uncertain && <Button disabled={busy} onClick={() => void send(uncertain)}>Retry</Button>}</div>}
        {task.proposed && <div className="k42-task-proposal" role="status">
          <p><Proposed /> An agent proposed this subtask. Nobody can take or start it until a project owner accepts it.</p>
          {detail.permissions.review && !readOnly && <div className="k42-task-actions">
            <Button className="primary" disabled={waiting} onClick={() => base && void act({ operation: 'review_proposal', ...base, accept: true })}>Accept</Button>
            <Button disabled={waiting} onClick={() => base && void act({ operation: 'review_proposal', ...base, accept: false })}>Decline</Button></div>}
        </div>}
        <div className="k42-task-chips">
          {readOnly || !canControl ? <span className={`k42-task-status is-${task.status}`}>{statusLabel(task.status)}</span>
            : <PickerMenu label="Status" disabled={waiting} summary={<span className={`k42-task-status is-${task.status}`}>{statusLabel(task.status)}<ChevronDown size={14} aria-hidden="true" /></span>}
                items={TASK_STATUSES.map(s => { const blocked = task.status === s.id ? null : statusChangeBlock(task, s.id);
                  return { key: s.id, label: <span>{s.label}</span>, checked: task.status === s.id, disabled: !!blocked, title: blocked ?? undefined,
                    onSelect: () => { if (task.status !== s.id && base) void act({ operation: 'update', ...base, status: s.id }); } }; })} />}
          {readOnly || !assignmentChoices.length ? task.assignedAgentId ? <TaskAgentHover id={task.assignedAgentId} agents={directory.agent} /> : noOwner
            : <PickerMenu label="Owner" disabled={waiting} summary={task.assignedAgentId ? face(task.assignedAgentId) : noOwner}
                items={[...assignmentChoices.map(a => ({ key: a.id, label: <AgentChip id={a.id} directory={directory} size={24} />, checked: a.id === task.assignedAgentId, onSelect: () => { if (a.id !== task.assignedAgentId && base) void act({ operation: 'assign', ...base, assignedAgentId: a.id }); } })),
                  ...(task.assignedAgentId && canControl ? [{ key: 'release', label: <span>Release to Backlog</span>, onSelect: () => base && void act({ operation: 'release', ...base }) }] : [])]} />}
          {task.contributors.length > 0 && <TaskContributorAvatars contributors={task.contributors} agents={directory.agent} />}
          {readOnly ? task.priority !== 'normal' && <span className="k42-task-chip">{priorityLabel(task.priority)}</span>
            : <PickerMenu label="Priority" disabled={waiting} summary={<span className="k42-task-chip">{priorityLabel(task.priority)}</span>}
                items={(['low', 'normal', 'high'] as const).map(p => ({ key: p, label: <span>{priorityLabel(p)}</span>, checked: task.priority === p, onSelect: () => { if (task.priority !== p && base) void act({ operation: 'update', ...base, priority: p }); } }))} />}
          {task.references.map(r => { const v = taskReferenceView(r), href = v.href ?? taskSourceHref(r, projectId, viewerUrl);
            // A pull request reads as its repository and number; a label the agent gave it shows on hover.
            const text = <>{r.kind === 'pull_request' && <GitPullRequest size={14} aria-hidden="true" />}{v.destination ?? v.text}</>;
            return <span key={r.id} className="k42-task-chip k42-task-link-chip" title={v.destination ? `${v.label}: ${v.text}` : v.label}>
              {v.href || !('sourceId' in r && go && projectId) ? href ? <a href={href} title={href} target="_blank" rel="noreferrer noopener">{text}</a> : <span>{text}</span>
                : <NavLink go={go} to={r.kind === 'conversation'
                  ? { view: 'project', projectId, section: 'conversations', thread: r.sourceId, agent: null, q: null }
                  : { view: 'project', projectId, section: 'conversations', thread: null, agent: null, q: null, message: r.sourceId }}>{v.text}</NavLink>}
              {!readOnly && base && <button type="button" className="k42-task-chip-remove" aria-label={`Remove ${v.label.toLowerCase()}: ${v.text}`} disabled={waiting} onClick={() => void act({ operation: 'remove_reference', ...base, referenceId: r.id })}><X size={14} aria-hidden="true" /></button>}
            </span>; })}
          {!readOnly && <button type="button" className="k42-task-add" aria-label="Add link" title="Add link" aria-expanded={linkOpen} onClick={() => setLinkOpen(true)}><Plus size={18} aria-hidden="true" /></button>}
        </div>
        {!readOnly && (task.status === 'canceled' ? <p className="muted k42-task-hint">Reopen to Backlog to work on it. Canceling doesn’t stop an agent.</p> : !task.assignedAgentId && <p className="muted k42-task-hint">Assign an agent before starting or completing this task.</p>)}
        {task.assignedAgentId && directory.gone(task.assignedAgentId) && <p className="muted k42-task-hint">This agent left the project. The assignment stays until released.</p>}
        {!readOnly && linkOpen && <form className="k42-task-inline" onSubmit={addLink} onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); setLinkOpen(false); setLink(''); setLinkLabel(''); } }}>
          <input aria-label="Link URL" type="url" value={link} readOnly={waiting} onChange={e => setLink(e.target.value)} placeholder="Paste a PR, result or conversation link, then Enter" autoFocus />
          <input aria-label="Link label (optional)" value={linkLabel} readOnly={waiting} onChange={e => setLinkLabel(e.target.value)} maxLength={120} placeholder="Label (optional)" />
          <button type="submit" hidden /></form>}

        {task.description ? <p className="k42-task-description">{task.description}</p> : <p className="muted">No description.</p>}

        <Subtasks api={api} parent={task} subtasks={subtasks} directory={directory} readOnly={readOnly || !!task.proposed} onOpen={leave} onCreated={() => void reload()} />

        <section className="k42-task-section" aria-label="Activity">
          <h3>Activity</h3>
          {(detail.nextCommentCursor || detail.nextActivityCursor) && <Button onClick={() => { if (detail.nextCommentCursor) more('comments'); if (detail.nextActivityCursor) more('activity'); }}>Show older activity</Button>}
          <ol className="k42-task-feed">{activityFeed(detail).map(item => item.kind === 'comment'
            ? <li key={item.id} className="k42-task-feed-comment"><div className="k42-task-comment-meta"><ActorChip actor={item.comment.author} directory={directory} /><span className="muted">{when(item.comment.createdAt)}</span></div><p>{item.comment.body}</p></li>
            : <li key={item.id} className="k42-task-feed-event"><ActorChip actor={item.actor} directory={directory} /> <span>{item.labels.join(', ')}</span> <span className="muted">{when(item.at)}</span></li>)}</ol>
          {!readOnly && <form onSubmit={sendComment}><textarea aria-label="Comment" className="k42-task-textarea" rows={2} value={comment} onChange={e => setComment(e.target.value)} placeholder="Add an update, a question or a result" />
            {comment.trim() && <div className="k42-task-actions"><Button type="submit" className="primary" disabled={waiting}>Comment</Button></div>}</form>}
        </section>
      </>}
  </article>;
}

const priorityLabel = (priority: NativeTask['priority']) => `${priority[0].toUpperCase()}${priority.slice(1)} priority`;
type FeedItem = { kind: 'comment'; id: string; at: number; comment: NativeTaskDetail['comments'][number] } | { kind: 'event'; id: string; at: number; actor: NativeTaskActor; labels: string[] };
/** Comments and history in one feed, oldest first; back-to-back events by the same actor share one line. */
function activityFeed(detail: NativeTaskDetail): FeedItem[] {
  const items: FeedItem[] = [...detail.comments.map(c => ({ kind: 'comment' as const, id: c.id, at: c.createdAt, comment: c })),
    ...detail.activity.filter(a => a.action !== 'comment').map(a => ({ kind: 'event' as const, id: a.id, at: a.at, actor: a.actor, labels: [historyLabel(a)] }))].sort((a, b) => a.at - b.at);
  const feed: FeedItem[] = [];
  for (const item of items) {
    const last = feed.at(-1);
    if (item.kind === 'event' && last?.kind === 'event' && last.actor.kind === item.actor.kind && last.actor.id === item.actor.id) {
      feed[feed.length - 1] = { ...last, at: item.at, labels: last.labels.includes(item.labels[0]) ? last.labels : [...last.labels, item.labels[0]] };
    } else feed.push(item);
  }
  return feed;
}

/** The page's subtasks: full tasks with one parent. A quick title adds one, unassigned in Backlog. */
function Subtasks({ api, parent, subtasks, directory, readOnly, onOpen, onCreated }: {
  api: TasksApi; parent: NativeTask; subtasks: NativeTaskSummary[]; directory: Directory; readOnly: boolean; onOpen: (id: string) => void; onCreated: () => void;
}) {
  const [title, setTitle] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [adding, setAdding] = useState(false);
  // One request ID per draft, so a retry after an unknown outcome cannot add the subtask twice.
  const requestId = useRef(crypto.randomUUID()), inputId = useId();
  const add = (event: FormEvent) => {
    event.preventDefault();
    const value = title.trim();
    if (!value || busy) return;
    setBusy(true); setError(null);
    api.mutate(taskMutation({ operation: 'create', title: value, parentId: parent.id }, requestId.current)).then(() => {
      requestId.current = crypto.randomUUID(); setTitle(current => current.trim() === value ? '' : current); onCreated();
    }, e => {
      const settled = isSettledRefusal(e);
      if (settled) requestId.current = crypto.randomUUID();
      setError(settled ? errorText(e) : 'Could not confirm the subtask was added. Add again sends the same request; it will not add a duplicate.');
    }).finally(() => setBusy(false));
  };
  const progress = parent.subtaskProgress;
  const close = () => { if (!busy) { setAdding(false); setTitle(''); setError(null); } };
  if (readOnly && !subtasks.length) return null;
  return <section className="k42-task-section" aria-labelledby={`${inputId}-heading`}>
    <div className="k42-task-section-head"><h3 id={`${inputId}-heading`}>Subtasks</h3>{progress && <SubtaskRing {...progress} />}
      {!readOnly && <button type="button" className="k42-task-add" aria-label="Add subtask" title="Add subtask" aria-expanded={adding} onClick={() => setAdding(true)}><Plus size={18} aria-hidden="true" /></button>}</div>
    {subtasks.length ? <ul className="k42-task-subtasks">{subtasks.map(row => <li key={row.id}>
      <button type="button" className="k42-task-open" onClick={() => onOpen(row.id)}>{row.title}</button>
      {row.proposed && <Proposed />}
      <span className="k42-task-subtask-meta">{row.assignedAgentId ? <TaskAgentHover id={row.assignedAgentId} agents={directory.agent} size={24} /> : <Unassigned />}
        <span className={`k42-task-status is-${row.status}`}>{statusLabel(row.status)}</span></span>
    </li>)}</ul> : null}
    {progress && progress.total > 0 && progress.done === progress.total && !closedTask(parent) && <p className="muted k42-task-hint-inline">All subtasks are done or canceled. This task’s own status is still {statusLabel(parent.status)}.</p>}
    {/* Enter adds; Escape, or leaving the empty field, closes it. */}
    {!readOnly && adding && <form className="k42-task-inline" onSubmit={add}>
      <input id={inputId} aria-label="New subtask title" value={title} maxLength={300} readOnly={busy} onChange={e => setTitle(e.target.value)} placeholder="Subtask title, then Enter" autoFocus
        onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } }} onBlur={() => { if (!title.trim()) close(); }} /></form>}
    {error && <p role="alert" className="error">{error}</p>}
  </section>;
}

type PickerItem = { key: string; label: ReactNode; checked?: boolean; disabled?: boolean; title?: string; onSelect: () => void };
/** The summary (a chip or a face) is the control: it opens a small menu, like the selected simple-tasks design. */
function PickerMenu({ label, summary, items, disabled }: { label: string; summary: ReactNode; items: PickerItem[]; disabled?: boolean }) {
  const [open, setOpen] = useState(false), trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null), menuId = useId();
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const buttons = [...(menu.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])], at = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[(at + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus(); event.preventDefault();
      }
    };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', key, true); };
  }, [open]);
  return <div className="k42-task-picker">
    <button ref={trigger} type="button" className="k42-task-picker-trigger" aria-haspopup="menu" aria-expanded={open} aria-controls={menuId} aria-label={`${label}: change`} disabled={disabled} onClick={() => setOpen(v => !v)}>{summary}</button>
    {open && <div ref={menu} id={menuId} role="menu" aria-label={label} className="k42-task-picker-menu">
      {items.map(item => <button key={item.key} type="button" role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'} aria-checked={item.checked}
        className="k42-task-picker-item" disabled={item.disabled} title={item.title} onClick={() => { item.onSelect(); setOpen(false); trigger.current?.focus(); }}>
        {item.label}{item.checked && <Check size={16} aria-hidden="true" />}</button>)}
    </div>}
  </div>;
}

function historyLabel(event: NativeTaskActivity) {
  const labels:Record<string,string>={create:'created the task',claim:'claimed the task',release:'released the task to Backlog',assign:'changed the assigned agent',comment:'added a comment',edit_comment:'edited a comment',add_reference:'added a link',remove_reference:'removed a link',review_proposal:'reviewed the proposal'};
  const fields:Record<string,string>={title:'title',description:'description',status:'status',assignedAgentId:'assigned agent',priority:'priority',contributors:'contributors',references:'links',proposed:'proposal'};
  return event.action==='update' ? `changed ${event.fields?.map(f=>fields[f]??f).join(', ') || 'task details'}` : labels[event.action];
}
