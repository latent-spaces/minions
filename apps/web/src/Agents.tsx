import { AgentStatusIcon } from './ui/AgentStatusIcon';
import { CodingAgentAvatar, CodingAgentLabel } from './ui/CodingAgentAvatar';
import { personaChoice } from '@mlswarm/contracts';
import { PersonLink } from './ui/PersonLink';
import { RemoveAgent } from './ui/RemoveAgent';
import { AgentRunPanel } from './ui/AgentRunControls';
import { AgentCard } from './ui/AgentCard';
import { AgentPersona } from './ui/AgentPersona';
import { AgentCommunication } from './ui/AgentCommunication';
import { AgentEnvironment } from './ui/AgentEnvironment';
import { AgentFocus } from './ui/AgentFocus';
import { AgentUsage, UsageSummary, UsageValue } from './ui/UsageSummary';
import { normalizeReportedUsage, type HumanRequest } from '@mlswarm/contracts';
import { COMMUNICATION_AGENT_LABELS, communicationAgentState } from './ui/communication-agent-state';
// A project's Agents tab: a directory searched by name, and one agent's page. Runner contact, the
// reported phase, the last reported action and usage are separate observations, and none of them
// says what the agent is working on. Unknown stays unknown; no dollars, no rankings, no history.
import type { SessionUser } from './session-identity';
import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { ApiError, read, ProjectScope, type AgentRow, type OwnedTask } from './api';
import { useMyWorkers } from './ui/MyWorkerControls';
import { ModelMark } from './ui/ModelMark';
import { formatRoute, projectRoute, type Route } from './route';
import { ago, NavLink, Pager, time, usePages } from './shared';
import { statusLabel } from './tasks-api';


// The agent's status, in the same words as everywhere else; it is not a measure of current work.
function Phase({ agent, now }: { agent: AgentRow; now: number }) {
  const state = communicationAgentState(agent, now), at = agent.v2Contact?.phaseAt;
  return <span className={`agent-phase ${state === 'working' ? 'turn k42-tone-sky' : state === 'idle' ? 'idle' : 'unknown'}`} title={at ? `Reported ${time(at, true, now)}` : undefined}><AgentStatusIcon state={state} decorative />{COMMUNICATION_AGENT_LABELS[state]}</span>;
}

// A short age for cards and lists; the full time is in the title.
export function Since({ at, now }: { at: number; now: number }) {
  return <time dateTime={new Date(at).toISOString()} title={time(at, false)}>{ago(at, now) || new Date(at).toLocaleDateString()}</time>;
}

function tokenAmount(usage: AgentRow['usage'], key: 'uncached' | 'output') {
  return <UsageValue value={normalizeReportedUsage(usage)[key]} />;
}

function LastContact({ agent, now }: { agent: AgentRow; now: number }) {
  if (agent.v2Contact) return <Since at={agent.v2Contact.lastContactAt} now={now} />;
  return <>Unknown</>;
}

// The agents this account operates in the open project, for the My agent mark. Unknown when unread.
function useMine() {
  const data = useMyWorkers()?.data;
  return data ? new Set(data.agents.map(a => a.agentId)) : null;
}


export function Agents({ user, agent, search, onAgent, tick, active, go, filter = 'all', waiting }: { user: SessionUser | null; agent: string | null; search: string | null; onAgent: (projectId: string, id: string, name: string) => void; tick: number; active: boolean; go: (to: Route) => void; filter?: 'mine' | 'all'; waiting?: HumanRequest[] }) {
  const mine = useMine();
  // Other sections' addresses carry no search, so the search changes only while Agents is shown. The directory
  // stays mounted under an open agent and elsewhere, so Back returns to the same search and page.
  const [q, setQ] = useState(search);
  if (active && filter === 'all' && q !== search) setQ(search);
  return <>
    <div hidden={agent !== null || filter !== 'all'}><Directory user={user} q={q} mine={mine} tick={tick} active={active && agent === null && filter === 'all'} go={go} /></div>
    {agent !== null && <Detail key={agent} user={user} id={agent} q={filter === 'all' ? q : null} filter={filter} onAgent={onAgent} mine={mine} tick={tick} active={active} go={go} waiting={waiting} />}
  </>;
}

// The search is part of the address, so a reload, a copied link and Back keep it.
function Directory({ user, q, mine, tick, active, go }: { user: SessionUser | null; q: string | null; mine: Set<string> | null; tick: number; active: boolean; go: (to: Route) => void }) {
  const projectId = useContext(ProjectScope);
  // The pager goes while the next page loads, so the heading keeps focus.
  const heading = useRef<HTMLHeadingElement>(null);
  const path = useCallback((cursor: string | null) => {
    const query = new URLSearchParams();
    if (q) query.set('q', q);
    if (cursor) query.set('cursor', cursor);
    const search = query.toString();
    return `/agents${search ? `?${search}` : ''}`;
  }, [q]);
  const { page, error, first, older, newer } = usePages<AgentRow>(user, path, tick, active);
  const now = page?.serverTime ?? Date.now();
  return <section className="agents-page" aria-labelledby="agents-title">
    <h2 id="agents-title" ref={heading} tabIndex={-1} className="visually-hidden">All agents</h2>
    {error && <p className="error" role="alert">Could not load agents: {error}</p>}
    {!page && !error && <p className="muted" role="status">Loading agents…</p>}
    {/* Always present, so a screen reader announces each new search result. */}
    <p className="muted agent-search-status" role="status">{page && q && first ? (page.items.length === 0 ? `No agent names start with “${q}”.` : `Agents whose names start with “${q}”.`) : ''}</p>
    {page?.items.length === 0 && !first && <p className="muted">No more agents.</p>}
    {page?.items.length === 0 && first && !q && <div className="agent-empty">
      <h3>No agents yet</h3>
      <p className="muted">Agents appear here when people add them.</p>
    </div>}
    {!!page?.items.length && <UsageSummary rows={page.items.map(a => a.usage)} scope="Agents on this page" />}
    {!!page?.items.length && <ul className="agent-grid">{page.items.map(a => <li key={a.id}>
      <AgentCard provider={a.usage?.provider} agentId={a.id} ownerId={a.operatorId} persona={a.personaChoice} name={a.name} identity={a.name} operator={a.operatorId && a.operatorName ? <PersonLink photo={a.operatorPhoto} id={a.operatorId} name={a.operatorName} /> : a.operatorName ? `@${a.operatorName}` : 'Removed person'} mine={mine?.has(a.id)} revoked={!!a.revokedAt}
        phase={<Phase agent={a} now={now} />}
        focus={<AgentFocus focus={a.focus} now={now} />}
        model={a.usage?.model ? <span className="k42-model-name"><ModelMark model={a.usage.model} provider={a.usage.provider} />{a.usage.model}</span> : 'Unknown'} contact={<LastContact agent={a} now={now} />}
        input={tokenAmount(a.usage, 'uncached')}
        output={tokenAmount(a.usage, 'output')}
        viewAgent={a.id.startsWith('queued-') ? null : <NavLink to={projectRoute(projectId,'agents',a.id,q,'all')} go={go}>View agent<span className="visually-hidden"> {a.name}</span><span aria-hidden="true"> →</span></NavLink>} />
    </li>)}</ul>}
    <div className="agent-directory-footer">
      <p className="agent-help">Status and usage come from what each agent last reported.</p>
      <Pager first={first} hasNext={!!page?.next} onBack={() => { heading.current?.focus(); newer(); }} onNext={() => { heading.current?.focus(); older(); }} nextLabel="More agents" />
    </div>
  </section>;
}

function Detail({ user, id, q, filter, onAgent, mine, tick, active, go }: { user: SessionUser | null; id: string; q: string | null; filter: 'mine' | 'all'; onAgent: (projectId: string, id: string, name: string) => void; mine: Set<string> | null; tick: number; active: boolean; go: (to: Route) => void; waiting?: HumanRequest[] }) {
  const projectId = useContext(ProjectScope);
  const [result, setResult] = useState<{ agent: AgentRow; serverTime: number } | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [clock, setClock] = useState(Date.now());
  const [runtimeOffset, setRuntimeOffset] = useState(0);
  useEffect(() => { if (!active) return; const timer = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(timer); }, [active]);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    read<{ agent: AgentRow; serverTime: number }>(user, `/agents/${id}`, projectId)
      .then(value => { if (!cancelled) { setResult(value); setError(null); setRuntimeOffset(value.serverTime - Date.now()); setClock(Date.now()); } }, (e: Error) => { if (!cancelled) setError(e); });
    return () => { cancelled = true; };
  }, [user, projectId, id, tick, active]);
  const missing = error instanceof ApiError && error.status === 404;
  const a = missing ? null : result?.agent ?? null;
  const now = result?.serverTime ?? Date.now();
  // Positive runtime observations expire between refreshes, independent of authored focus.
  const runtimeNow = clock + runtimeOffset;
  const runtimeState = communicationAgentState(a ?? undefined, runtimeNow);
  const usage = a?.usage ?? null;
  // The breadcrumb and the page title name the agent once it is read.
  const name = a?.name;
  useEffect(() => { if (name !== undefined) onAgent(projectId, id, name); }, [onAgent, projectId, id, name]);
  // Only the operator's own agents show their assigned tasks; other agents read as before.
  const own = mine?.has(id) ?? false;
  return <section className="agents-page agent-detail" aria-labelledby="agent-title">
    <div className="agent-page-toolbar">
      {/* Back returns to wherever the agent was opened from (owner, 19 October 2026); a direct link has no managed predecessor and falls back to the list. */}
      <a href={formatRoute(projectRoute(projectId, 'agents', null, q, filter))} className="agent-back" onClick={event => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        if (typeof window.history.state?.at === 'number' && window.history.state.at > 0) window.history.back(); else go(projectRoute(projectId, 'agents', null, q, filter));
      }}><span aria-hidden="true">← </span>Back</a>
      {a && <span className="agent-help">Updated {time(now, false)}</span>}
    </div>
    {missing && <div className="agent-empty"><h2 id="agent-title">Agent not available</h2><p role="alert">{error.message}</p></div>}
    {error && !missing && <div role="alert"><p className="error">Could not load this agent: {error.message}</p></div>}
    {!result && !error && <p className="muted" role="status">Loading agent…</p>}
    {a && <div className="agent-detail-columns">
      <div className="agent-main">
        <section className="agent-panel">
          <div className="agent-name-line"><span className="agent-profile-photo"><CodingAgentAvatar provider={a.usage?.provider} name={a.name} id={a.id} ownerId={a.operatorId} persona={a.personaChoice} size={76} decorative />
            <AgentStatusIcon state={runtimeState} overlay /></span>
            <h2 id="agent-title">{a.name}</h2>
            {mine?.has(a.id) && <span className="agent-mine k42-tone-butter">My agent</span>}
            {a.revokedAt !== null && <span className="badge k42-tone-blush">Revoked</span>}
          </div>
          {a.revokedAt === null && own && user && <AgentRunPanel user={user} projectId={projectId} agentId={a.id} />}
          {a.revokedAt === null && own && user && <RemoveAgent user={user} projectId={projectId} agentId={a.id} agentName={a.name} onRemoved={() => go(projectRoute(projectId, 'agents', null, null, 'mine'))} />}
          <p className="muted">Agent of {a.operatorName ?? 'an unknown person'}</p>
          <div className="agent-current-work">
            <h3>{runtimeState === 'working' ? 'Current work' : 'Last reported focus'}</h3>
            {a.focus ? <AgentFocus focus={a.focus} now={now} /> : <p className="muted">No focus update reported.</p>}
            <p className="agent-current-observation"><strong>{COMMUNICATION_AGENT_LABELS[runtimeState]}</strong>
              <span className="muted">{result ? <>Checked {time(result.serverTime, true, runtimeNow)}</> : 'Status not available'}</span></p>
          </div>
          <dl className="agent-profile-stats">
            <div><dt>Reported model</dt><dd>{usage?.model ? <span className="k42-model-name"><ModelMark model={usage.model} provider={usage.provider} />{usage.model}</span> : 'Unknown'}</dd></div>
            <div><dt>Last contact</dt><dd><LastContact agent={a} now={now} /></dd></div>
            <div><dt>Work report</dt><dd>{own ? 'In Tasks, as the assigned agent' : 'Unknown'}</dd></div>
          </dl>
        </section>
        <AgentUsage usage={usage} now={now} />
        <AgentPersona key={`${user?.uid ?? 'guest'}:${projectId}:${id}`} user={user} projectId={projectId} agentId={id} agentName={a.name} ownerId={a.operatorId} onSaved={text => setResult(previous => previous ? {...previous, agent: {...previous.agent, personaChoice: personaChoice(text)}} : previous)} active={active} tick={tick} />
        {own && user && <AgentEnvironment key={`${user.uid}:${projectId}:${id}`} user={user} projectId={projectId} agentId={id} active={active} tick={tick} />}
        {own ? <OwnedTasks user={user} id={id} tick={tick} active={active} /> : <section className="agent-panel" aria-labelledby="agent-responsibility">
          <h3 id="agent-responsibility">Current responsibility</h3>
          <p>Conversations, tasks and pull requests show the work.</p>
        </section>}
        <section className="agent-panel" aria-labelledby="agent-activity">
          <h3 id="agent-activity">Reported activity</h3>
          <dl className="agent-details-list">
            <div><dt>Last reported action</dt><dd>{a.activity ? <>{a.activity.tool} · {time(a.activity.at, true, now)}</> : 'Nothing reported yet'}</dd></div>
          </dl>
          <p className="agent-help">Shows the latest report only.</p>
        </section>
        <section className="agent-panel" aria-labelledby="agent-conversations">
          <div className="agent-section-line">
            <h3 id="agent-conversations">Conversations</h3>
            <NavLink to={projectRoute(projectId, 'conversations')} go={go}>View conversations</NavLink>
          </div>
          <p className="agent-help">Conversations are not filtered by agent yet.</p>
        </section>
      </div>
      <aside className="agent-side" aria-label="Agent details">
        <AgentCommunication key={`${user?.uid ?? 'guest'}:${projectId}:${id}`} user={user} projectId={projectId} agentId={id} active={active} tick={tick} />
        <section className="agent-panel" aria-labelledby="agent-details">
          <h3 id="agent-details">Agent details</h3>
          <dl className="agent-details-list">
            <div><dt>Name</dt><dd>{a.name}</dd></div>
            <div><dt>Agent of</dt><dd>{a.operatorName ?? 'Removed person'}</dd></div>
            <div><dt>Added</dt><dd>{time(a.createdAt, false)}</dd></div>
            <div><dt>Access</dt><dd>{a.revokedAt !== null ? `Revoked ${time(a.revokedAt, false)}` : 'Active'}</dd></div>
            <div><dt>Last check-in</dt><dd>{a.v2Contact ? time(a.v2Contact.lastContactAt, true, now) : 'Not recorded'}</dd></div>
            <div><dt>Status reported</dt><dd>{a.v2Contact ? time(a.v2Contact.phaseAt, true, now) : 'Not recorded'}</dd></div>
            <div><dt>Coding agent</dt><dd><CodingAgentLabel provider={usage?.provider} /></dd></div>
          </dl>
        </section>

      </aside>
    </div>}
  </section>;
}

// Tasks are the shared responsibility record; agent runtime status remains a separate observation.
function OwnedTasks({ user, id, tick, active }: { user: SessionUser | null; id: string; tick: number; active: boolean }) {
  const heading = useRef<HTMLHeadingElement>(null), projectId = useContext(ProjectScope);
  const path = useCallback((cursor: string | null) => `/agents/${id}/responsibilities${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, [id]);
  const { page, error, first, older, newer } = usePages<OwnedTask>(user, path, tick, active);
  const now = page?.serverTime ?? Date.now();
  return <section className="agent-panel" aria-labelledby="agent-responsibility">
    <h3 id="agent-responsibility" ref={heading} tabIndex={-1}>Assigned tasks</h3>
    {error && <p className="error" role="alert">Could not load assigned tasks: {error}</p>}
    {!page && !error && <p className="muted" role="status">Loading assigned tasks…</p>}
    {page?.items.length === 0 && <p>{first ? 'No tasks are assigned to this agent.' : 'No more assigned tasks.'}</p>}
    {!!page?.items.length && <ul className="list">{page.items.map(task => <li key={task.id}>
      <a href={formatRoute(projectRoute(projectId))}>{task.title}</a>
      <span className="muted"> · {statusLabel(task.status)} · Updated {time(task.updatedAt, true, now)}</span>
    </li>)}</ul>}
    <Pager first={first} hasNext={!!page?.next} onBack={() => { heading.current?.focus(); newer(); }} onNext={() => { heading.current?.focus(); older(); }} nextLabel="More assigned tasks" />
    <p className="agent-help">Assignment records responsibility. It does not start work or expire when the agent stops.</p>
  </section>;
}
