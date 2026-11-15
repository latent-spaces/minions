import { AgentStatusIcon } from './ui/AgentStatusIcon';
import { CodingAgentAvatar, CodingAgentLabel } from './ui/CodingAgentAvatar';
import { personaChoice } from '@minions/contracts';
import { useRemoveAgent } from './ui/RemoveAgent';
import { AgentRunActions } from './ui/AgentRunControls';
import { PickerMenu } from './ui/PickerMenu';
import { Ellipsis } from 'lucide-react';
import { AgentPersona } from './ui/AgentPersona';
import { AgentEnvironment } from './ui/AgentEnvironment';
import { AgentUsage } from './ui/UsageSummary';
import type { HumanRequest } from '@minions/contracts';
import { ChatWork } from './ui/ChatParticipationControls';
import { COMMUNICATION_AGENT_LABELS, communicationAgentState } from './ui/communication-agent-state';
// One agent's page; the Agents section's card directory is CommunityDirectory. Unknown stays unknown;
// no dollars, no rankings, no history.
import type { SessionUser } from './session-identity';
import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { ApiError, read, ProjectScope, type AgentRow, type OwnedTask } from './api';
import { useMyWorkers } from './ui/MyWorkerControls';
import { ModelMark } from './ui/ModelMark';
import { formatRoute, projectRoute, taskRoute, type Route } from './route';
import { ago, NavLink, Pager, time, usePages } from './shared';
import { statusLabel } from './tasks-api';


// A short age for cards and lists; the full time is in the title.
export function Since({ at, now }: { at: number; now: number }) {
  return <time dateTime={new Date(at).toISOString()} title={time(at, false)}>{ago(at, now) || new Date(at).toLocaleDateString()}</time>;
}

// The agents this account operates in the open project, for the My agent mark. Unknown when unread.
function useMine() {
  const data = useMyWorkers()?.data;
  return data ? new Set(data.agents.map(a => a.agentId)) : null;
}


export function Agents({ user, agent, search, onAgent, tick, active, go, waiting }: { user: SessionUser | null; agent: string | null; search: string | null; onAgent: (projectId: string, id: string, name: string) => void; tick: number; active: boolean; go: (to: Route) => void; waiting?: HumanRequest[] }) {
  const mine = useMine();
  // The card directory (App) keeps the search; an open agent's Back returns to it.
  return agent !== null ? <Detail key={agent} user={user} id={agent} q={search} onAgent={onAgent} mine={mine} tick={tick} active={active} go={go} waiting={waiting} /> : null;
}

function Detail({ user, id, q, onAgent, mine, tick, active, go }: { user: SessionUser | null; id: string; q: string | null; onAgent: (projectId: string, id: string, name: string) => void; mine: Set<string> | null; tick: number; active: boolean; go: (to: Route) => void; waiting?: HumanRequest[] }) {
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
  const [environment, setEnvironment] = useState(false);
  const controls = own && user && a && a.revokedAt === null;
  return <section className="agents-page agent-detail" aria-labelledby="agent-title">
    <div className="agent-page-toolbar">
      {/* Back returns to wherever the agent was opened from (owner, 19 October 2026); a direct link has no managed predecessor and falls back to the list. */}
      <a href={formatRoute(projectRoute(projectId, 'agents', null, q))} className="agent-back" onClick={event => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        if (typeof window.history.state?.at === 'number' && window.history.state.at > 0) window.history.back(); else go(projectRoute(projectId, 'agents', null, q));
      }}><span aria-hidden="true">← </span>Back</a>
    </div>
    {missing && <div className="agent-empty"><h2 id="agent-title">Agent not available</h2><p role="alert">{error.message}</p></div>}
    {error && !missing && <div role="alert"><p className="error">Could not load this agent: {error.message}</p></div>}
    {!result && !error && <p className="muted" role="status">Loading agent…</p>}
    {/* One column, read top to bottom (owner, 12 November 2026): who it is with one control, what it is doing, its tasks, then usage and persona. */}
    {a && <div className="agent-detail-page">
      <section className="agent-panel">
        <div className="agent-head">
          <span className="agent-profile-photo"><CodingAgentAvatar state={communicationAgentState(a, now)} provider={a.usage?.provider} name={a.name} id={a.id} ownerId={a.operatorId} persona={a.personaChoice} size={56} decorative />
            <AgentStatusIcon state={runtimeState} overlay /></span>
          <div className="agent-head-text">
            <div className="agent-name-line"><h2 id="agent-title">{a.name}</h2>
              {mine?.has(a.id) && <span className="agent-mine k42-tone-butter">My agent</span>}
              {a.revokedAt !== null && <span className="badge k42-tone-blush">Removed</span>}</div>
            <p className="agent-meta">{!own && <>{a.operatorName ? `${a.operatorName}’s agent` : 'Agent of a removed person'} · </>}<CodingAgentLabel provider={usage?.provider} />
              {usage?.model && <> · <span className="k42-model-name"><ModelMark model={usage.model} provider={usage.provider} />{usage.model}</span></>} · added {new Date(a.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</p>
          </div>
          {controls && <AgentHeadControls user={user} projectId={projectId} agentId={a.id} agentName={a.name} onEnvironment={() => setEnvironment(true)}
            onRemoved={() => go(projectRoute(projectId, 'agents', null, null))} />}
        </div>
        <div className="agent-now">
          <p className="agent-now-state"><AgentStatusIcon state={runtimeState} decorative />{COMMUNICATION_AGENT_LABELS[runtimeState]}{a.v2Contact && <> · last heard from <Since at={a.v2Contact.lastContactAt} now={runtimeNow} /></>}</p>
          <p className="agent-now-focus">{a.focus?.text ?? <span className="muted">No focus reported yet.</span>}</p>
        </div>
        {controls && <AgentChatWork agentId={a.id} />}
      </section>
      {controls && environment && <AgentEnvironment key={`${user.uid}:${projectId}:${id}:environment`} user={user} projectId={projectId} agentId={id} active={active} tick={tick} onClose={() => setEnvironment(false)} />}
      {own && <OwnedTasks user={user} id={id} tick={tick} active={active} go={go} />}
      <div className="agent-detail-pair">
        <AgentUsage usage={usage} />
        <AgentPersona key={`${user?.uid ?? 'guest'}:${projectId}:${id}:persona`} user={user} projectId={projectId} agentId={id} agentName={a.name} provider={a.usage?.provider} ownerId={a.operatorId} onSaved={text => setResult(previous => previous ? {...previous, agent: {...previous.agent, personaChoice: personaChoice(text)}} : previous)} active={active} tick={tick} />
      </div>
    </div>}
  </section>;
}

// Start, Pause or Resume — whichever applies now — and a ⋯ menu for the rest.
function AgentHeadControls({ user, projectId, agentId, agentName, onEnvironment, onRemoved }: { user: SessionUser; projectId: string; agentId: string; agentName: string; onEnvironment: () => void; onRemoved: () => void }) {
  const workers = useMyWorkers(), agent = workers?.data?.agents.find(row => row.agentId === agentId);
  const removal = useRemoveAgent({ user, projectId, agentId, agentName, onRemoved });
  return <div className="agent-head-controls">
    {workers && agent && <AgentRunActions user={user} projectId={projectId} agent={agent} controls={workers} now={workers.now} disabled={false} />}
    <PickerMenu label={`More for ${agentName}`} triggerLabel={`More for ${agentName}`} align="end" disabled={removal.busy} summary={<Ellipsis size={18} aria-hidden="true" />}
      items={[{ key: 'environment', label: 'Local environment', onSelect: onEnvironment },
        ...removal.available ? [{ key: 'remove', label: removal.busy ? 'Removing…' : 'Remove agent', onSelect: () => void removal.remove() }] : []]} />
    {removal.error && <p className="error" role="alert">{removal.error}</p>}
  </div>;
}

// Wake, Add time and End for an agent that works with the person in a chat; nothing shows otherwise.
function AgentChatWork({ agentId }: { agentId: string }) {
  const workers = useMyWorkers(), agent = workers?.data?.agents.find(row => row.agentId === agentId);
  if (!workers?.participation || !agent?.participation) return null;
  return <ChatWork agentId={agentId} agentName={agent.agentName} participation={agent.participation} controls={workers.participation} now={workers.now} disabled={!!workers.data?.projectClosed} />;
}

// Tasks are the shared responsibility record; agent runtime status remains a separate observation.
function OwnedTasks({ user, id, tick, active, go }: { user: SessionUser | null; id: string; tick: number; active: boolean; go: (to: Route) => void }) {
  const heading = useRef<HTMLHeadingElement>(null), projectId = useContext(ProjectScope);
  const path = useCallback((cursor: string | null) => `/agents/${id}/responsibilities${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, [id]);
  const { page, error, first, older, newer } = usePages<OwnedTask>(user, path, tick, active);
  return <section className="agent-panel" aria-labelledby="agent-responsibility">
    <h3 id="agent-responsibility" ref={heading} tabIndex={-1}>Tasks</h3>
    {error && <p className="error" role="alert">Could not load tasks: {error}</p>}
    {!page && !error && <p className="muted" role="status">Loading tasks…</p>}
    {page?.items.length === 0 && <p className="muted">{first ? 'No tasks yet.' : 'No more tasks.'}</p>}
    {!!page?.items.length && <ul className="agent-tasks">{page.items.map(task => <li key={task.id}>
      <NavLink to={taskRoute(projectId, task.id)} go={go}>{task.title}</NavLink>
      <span className={`k42-task-status is-${task.status}`}>{statusLabel(task.status)}</span>
    </li>)}</ul>}
    <Pager first={first} hasNext={!!page?.next} onBack={() => { heading.current?.focus(); newer(); }} onNext={() => { heading.current?.focus(); older(); }} nextLabel="More tasks" />
  </section>;
}
