import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NativeTeamDetail, NativeTeamPage, NativeTeamAction } from '@mlswarm/contracts';
import { ChevronRight, RefreshCw, Search, Users } from 'lucide-react';
import type { TeamsApi } from '../teams-api';
import { useLabelLookup } from '../label-lookup';
import { isAccessLoss } from '../task-model';
import type { TaskAgent, TaskLabelLookup } from './ProjectTasks';
import { TaskAgentAvatar } from './TaskAgentAvatar';
import { Button } from './Button';
import { EmptyState } from './EmptyState';
import { CloseButton } from './CloseButton';
import './segments.css';
import './project-tasks.css';
import './project-teams.css';
import { InfoTip } from './InfoTip';

const message = (error: unknown) => error instanceof Error ? error.message : 'Could not read teams. Try again.';
const when = (at: number) => new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const ACTION: Record<NativeTeamAction, string> = { create: 'created the team', join: 'joined', leave: 'left', archive: 'archived the team', restore: 'restored the team' };

/** Human observation of agent-created teams. Mutating team policy is owned by the agent service. */
export function ProjectTeams({ api, active, refreshToken = 0, disabledNotice, agents, lookup, scope }: {
  api: TeamsApi; active: boolean; refreshToken?: number; disabledNotice: boolean; agents: TaskAgent[]; lookup?: TaskLabelLookup; scope: string;
}) {
  const [archived, setArchived] = useState(false), [search, setSearch] = useState(''), [draft, setDraft] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const [state, setState] = useState<{ api: TeamsApi; archived: boolean; search: string; page: NativeTeamPage | null; busy: boolean; error: string }>({ api, archived, search, page: null, busy: true, error: '' });
  const generation = useRef(0);
  const current = state.api === api && state.archived === archived && state.search === search;
  const page = current ? state.page : null, busy = !current || state.busy;
  const accessLost = useCallback((error: unknown) => {
    // A detail refusal applies to the whole project view. Invalidate any pending
    // directory read too, so a late response cannot restore already-cleared data.
    generation.current++;
    setSelected(null);
    setState({ api, archived, search, page: null, busy: false, error: message(error) });
  }, [api, archived, search]);
  const load = useCallback((cursor?: string) => {
    const mine = ++generation.current;
    setState(before => ({ api, archived, search, page: before.api === api && before.archived === archived && before.search === search ? before.page : null, busy: true, error: '' }));
    api.list(archived, search, cursor).then(next => {
      if (mine !== generation.current) return;
      setState(before => ({ api, archived, search, page: cursor && before.page ? { teams: [...before.page.teams, ...next.teams.filter(row => !before.page!.teams.some(old => old.id === row.id))], nextCursor: next.nextCursor } : next, busy: false, error: '' }));
    }, error => {
      if (mine !== generation.current) return;
      if (isAccessLoss(error)) { accessLost(error); return; }
      setState(before => ({ ...before, busy: false, error: message(error) }));
    });
  }, [api, archived, search, accessLost]);
  useEffect(() => {
    if (!active) return;
    load();
    return () => { generation.current++; };
  }, [active, load, refreshToken]);
  const busyRef = useRef(busy); busyRef.current = busy;
  useEffect(() => {
    if (!active) return;
    // Reconcile missed invalidations without polling hidden pages or piling up
    // requests behind a slow read. Stream reconnects also refresh both views.
    const timer = setInterval(() => {
      if (document.visibilityState === 'hidden' || busyRef.current) return;
      load(); setRefreshKey(value => value + 1);
    }, 60000);
    return () => clearInterval(timer);
  }, [active, load]);
  useEffect(() => {
    const next = draft.trim();
    if (next === search) return;
    const timer = setTimeout(() => { setSearch(next); setSelected(null); }, 250);
    return () => clearTimeout(timer);
  }, [draft, search]);
  const chooseFilter = (value: boolean) => { setArchived(value); setSelected(null); };
  return <section className="k42-teams" aria-label="Teams">
    <div className="k42-teams-heading"><div className="k42-section-heading"><h2 className="k42-section-title">Teams</h2><InfoTip label="Teams">How agents organize their work.</InfoTip></div>
      <Button className="k42-tasks-refresh" aria-label="Refresh teams" title="Refresh teams" disabled={!active || busy} onClick={() => { load(); setRefreshKey(value => value + 1); }}><RefreshCw size={16} aria-hidden="true" /></Button></div>
    {disabledNotice && <p className="muted" role="status">Teams are off. Existing teams, memberships and history are read-only.</p>}
    <div className="k42-teams-toolbar">
      <div className="k42-task-segments" aria-label="Team state"><Button className="k42-task-segment" aria-pressed={!archived} onClick={() => chooseFilter(false)}>Active</Button><Button className="k42-task-segment" aria-pressed={archived} onClick={() => chooseFilter(true)}>Archived</Button></div>
      <label className="k42-tasks-search"><Search className="k42-tasks-search-icon" size={16} aria-hidden="true" /><span className="visually-hidden">Search teams</span><input value={draft} maxLength={120} onChange={event => setDraft(event.target.value)} placeholder="Search teams…" type="search" /></label>
    </div>
    {current && state.error && <p role="alert" className="error">{state.error} <Button disabled={busy} onClick={() => load()}>Try again</Button></p>}
    {!page && busy && <p className="muted" role="status">Loading teams…</p>}
    {page && <div className={`k42-teams-split${selected ? ' has-selection' : ''}${!selected && !page.teams.length ? ' is-empty' : ''}`}>
      <div className="k42-teams-directory">
        {page.teams.length ? <ul aria-label={archived ? 'Archived teams' : 'Active teams'}>{page.teams.map(team => <li key={team.id}>
          <Button ref={element => { if (element) rows.current.set(team.id, element); else rows.current.delete(team.id); }} className="k42-team-row" aria-pressed={selected === team.id} aria-controls={selected === team.id ? 'k42-team-detail' : undefined} onClick={() => setSelected(team.id)}>
            <span><strong>{team.name}</strong><span className="muted">{team.memberCount} {team.memberCount === 1 ? 'member' : 'members'}</span></span><ChevronRight size={16} aria-hidden="true" />
          </Button></li>)}</ul> : <EmptyState icon={Users} tone={null} title={page.nextCursor ? 'More teams to search' : search ? 'No teams match' : archived ? 'No archived teams' : 'No teams yet'}>
          {page.nextCursor ? 'Show more to continue searching.' : search ? 'Try another team name.' : archived ? 'Archived teams will remain here with their membership and history.' : disabledNotice ? 'Enable Teams in Control center to let agents create and join teams.' : 'Agents can create teams and join them through MyLittleSwarm tools.'}
        </EmptyState>}
        {page.nextCursor && <Button disabled={busy} onClick={() => load(page.nextCursor!)}>{busy ? 'Loading…' : 'Show more teams'}</Button>}
      </div>
      {selected ? <TeamDetail key={selected} id={selected} api={api} active={active} refreshKey={refreshKey + refreshToken} agents={agents} lookup={lookup} scope={scope} onAccessLost={accessLost} close={() => { const id = selected; setSelected(null); requestAnimationFrame(() => rows.current.get(id)?.focus()); }} />
        : page.teams.length > 0 && <div className="k42-teams-placeholder"><Users size={24} aria-hidden="true" /><p>Select a team to see its purpose, members and history.</p></div>}
    </div>}
  </section>;
}

function TeamDetail({ id, api, active, refreshKey, agents, lookup, scope, close, onAccessLost }: { id: string; api: TeamsApi; active: boolean; refreshKey: number; agents: TaskAgent[]; lookup?: TaskLabelLookup; scope: string; close: () => void; onAccessLost: (error: unknown) => void }) {
  const [state, setState] = useState<{ api: TeamsApi; detail: NativeTeamDetail | null; busy: boolean; error: string }>({ api, detail: null, busy: true, error: '' });
  const generation = useRef(0);
  const panel = useRef<HTMLElement>(null);
  const detail = state.api === api ? state.detail : null;
  const load = useCallback((kind?: 'members' | 'activity', cursor?: string) => {
    const mine = ++generation.current;
    setState(before => ({ api, detail: before.api === api ? before.detail : null, busy: true, error: '' }));
    api.get(id, cursor ? kind === 'members' ? { memberCursor: cursor } : { activityCursor: cursor } : {}).then(next => {
      if (mine !== generation.current) return;
      setState(before => {
        // Never combine a later roster/history page with a different team revision.
        if (kind && before.detail && before.detail.team.revision !== next.team.revision) return { api, detail: null, busy: false, error: 'This team changed while paging. Refresh to read its current members and history.' };
        const prior = before.detail;
        return { api, detail: kind && prior ? { ...prior, team: next.team,
          ...(kind === 'members' ? { members: [...prior.members, ...next.members.filter(row => !prior.members.some(old => old.agentId === row.agentId))], nextMemberCursor: next.nextMemberCursor }
            : { activity: [...prior.activity, ...next.activity.filter(row => !prior.activity.some(old => old.id === row.id))], nextActivityCursor: next.nextActivityCursor }) } : next, busy: false, error: '' };
      });
    }, error => {
      if (mine !== generation.current) return;
      if (isAccessLoss(error)) { onAccessLost(error); return; }
      setState(before => ({ api, detail: before.detail, busy: false, error: message(error) }));
    });
  }, [api, id, onAccessLost]);
  useEffect(() => { if (active) load(); return () => { generation.current++; }; }, [active, load, refreshKey]);
  useEffect(() => {
    if (!active) return;
    panel.current?.focus({ preventScroll: true });
    if (window.matchMedia('(max-width: 720px)').matches) panel.current?.scrollIntoView({ block: 'start' });
  }, [active, id]);
  const listed = useMemo(() => new Map(agents.map(agent => [agent.id, agent])), [agents]);
  const wanted = detail ? [detail.team.createdByAgentId, ...detail.members.map(member => member.agentId), ...detail.activity.map(event => event.actorAgentId)] : [];
  const labelContext = useMemo(() => ({ api, id, scope, active, onAccessLost, alive: false, epoch: 0 }), [api, id, scope, active, lookup, onAccessLost]);
  const currentLabelContext = useRef(labelContext); currentLabelContext.current = labelContext;
  useEffect(() => {
    labelContext.alive = true; labelContext.epoch++;
    return () => { labelContext.alive = false; labelContext.epoch++; };
  }, [labelContext]);
  const readLabels = useMemo(() => !lookup ? null : async (ids: string[]) => {
    const epoch = labelContext.epoch;
    try {
      if (currentLabelContext.current !== labelContext || !labelContext.alive || !labelContext.active)
        throw new Error('This team label lookup is no longer active.');
      return await lookup.agents(ids);
    } catch (error) {
      // Labels use the same project authority as the detail. Do not let the
      // shared label hook swallow an access refusal, or let an old team's late
      // rejection erase a newer team/project after navigation or reactivation.
      if (currentLabelContext.current === labelContext && labelContext.alive && labelContext.active
        && labelContext.epoch === epoch && isAccessLoss(error)) labelContext.onAccessLost(error);
      throw error;
    }
  }, [lookup, labelContext]);
  const labels = useLabelLookup(active ? readLabels : null, scope, wanted, listed).rows;
  const actor = (agentId: string) => {
    const agent = labels.get(agentId);
    return <span className="k42-team-agent"><TaskAgentAvatar id={agentId} name={agent?.name ?? 'Agent'} agent={agent} /><span><strong>{agent?.name ?? 'Agent'}</strong><small>{agent?.operatorName ?? `Agent ${agentId}`}{agent?.revokedAt != null ? ' · removed' : ''}</small></span></span>;
  };
  return <section ref={panel} tabIndex={-1} id="k42-team-detail" className="k42-team-detail" aria-label="Team details" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); close(); } }}>
    <div className="k42-teams-heading"><h3>{detail?.team.name ?? 'Team details'}</h3><CloseButton label="Close team details" onClick={close} /></div>
    {state.api === api && state.error && <p role="alert" className="error">{state.error} <Button disabled={state.busy} onClick={() => load()}>Refresh team</Button></p>}
    {!detail && state.busy && <p className="muted" role="status">Loading team…</p>}
    {detail && <>
      {detail.team.archived && <p className="muted">Archived · any current team member can restore this team.</p>}
      <section><h4>Purpose</h4><p className="k42-team-purpose">{detail.team.purpose || 'No purpose provided.'}</p></section>
      <section><h4>Members ({detail.team.memberCount})</h4><ul className="k42-team-members">{detail.members.map(member => <li key={member.agentId}>{actor(member.agentId)}</li>)}</ul>
        {!detail.members.length && <p className="muted">No current members.</p>}
        {detail.nextMemberCursor && <Button disabled={state.busy} onClick={() => load('members', detail.nextMemberCursor!)}>Show more members</Button>}
      </section>
      <section><h4>Created by</h4>{actor(detail.team.createdByAgentId)}<p className="muted">{when(detail.team.createdAt)}</p></section>
      <section><div className="k42-teams-heading"><h4>History</h4><Button aria-label="Refresh team details" className="k42-tasks-refresh" disabled={state.busy} onClick={() => load()}><RefreshCw size={16} aria-hidden="true" /></Button></div>
        <ol className="k42-team-history">{detail.activity.map(event => <li key={event.id}><span>{labels.get(event.actorAgentId)?.name ?? `Agent ${event.actorAgentId}`} {ACTION[event.action]}</span><time dateTime={new Date(event.at).toISOString()}>{when(event.at)}</time></li>)}</ol>
        {detail.nextActivityCursor && <Button disabled={state.busy} onClick={() => load('activity', detail.nextActivityCursor!)}>Show earlier history</Button>}
      </section>
    </>}
  </section>;
}
