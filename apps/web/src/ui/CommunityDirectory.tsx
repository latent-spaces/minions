import { AgentStateSymbol, AgentStatusIcon } from './AgentStatusIcon';
import { useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Search, Users } from './icons';
import { directoryCounts, directoryEntries, filterDirectory, type DirectoryAgent, type DirectoryKind, type DirectoryMember } from '../community-directory';
import { projectRoute, type Route } from '../route';
import { NavLink, Pager } from '../shared';
import { Button } from './Button';
import { EmptyState } from './EmptyState';
import { SearchField } from './SearchField';
import { PersonAvatar } from './PersonAvatar';
import { CodingAgentAvatar } from './CodingAgentAvatar';
import { ago, time } from '../observation-time';
import { statusLabel } from '../task-model';
import type { CommunicationAgentState } from '@minions/contracts';
import { AvatarPokeButton } from './AvatarPoke';
import './project-tasks.css';
import './community-directory.css';

/** The Community tab: everyone in the project, people (circles) and agents (rounded squares with their owner's badge).
 *  It reads only the members and agents pages the project page already loads. */
/** The All / People / Agents chips; each filters the same cards in place. */
export function DirectoryChips({ counts, kind, onKind }: { counts: Record<DirectoryKind, number>; kind: DirectoryKind; onKind: (kind: DirectoryKind) => void }) {
  const kinds: [DirectoryKind, string][] = [['all', 'All'], ['people', 'People'], ['agents', 'Agents']];
  return <div className="k42-directory-chips" role="group" aria-label="Show">
    {kinds.map(([id, label]) => <Button key={id} type="button" className="k42-directory-chip" aria-pressed={kind === id} onClick={() => onKind(id)}>{label} · {counts[id]}</Button>)}
  </div>;
}
export type DirectoryPaging = { first: boolean; hasNext: boolean; onBack: () => void; onNext: () => void; error?: string | null };
export function CommunityDirectory({ projectId, members, agents, loading, now, go, kind = 'agents', onKind, paging, ownerFirst = true, agentQuery, onAgentQuery, agentActions }: { projectId: string; members: DirectoryMember[]; agents: DirectoryAgent[]; loading: boolean; now: number; go: (to: Route) => void; kind?: DirectoryKind; onKind?: (kind: DirectoryKind) => void; paging?: { people: DirectoryPaging; agents: DirectoryPaging }; ownerFirst?: boolean; agentQuery?: string; onAgentQuery?: (query: string) => void; agentActions?: (agentId: string) => ReactNode }) {
  const [search, setSearch] = useState('');
  const searchId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const serverSearch = kind === 'agents' && !!onAgentQuery;
  const query = serverSearch ? agentQuery ?? '' : search;
  const entries = useMemo(() => directoryEntries(members, agents, now, ownerFirst), [members, agents, now, ownerFirst]);
  const counts = directoryCounts(entries);
  const shown = filterDirectory(entries, kind, serverSearch ? '' : search);
  // A first agents page with nothing after it and no search means the project has no agents, not an empty page.
  const noAgents = kind === 'agents' && !query && !!paging?.agents.first && !paging.agents.hasNext;
  return <section className="k42-directory" aria-labelledby={`${searchId}-title`}>
    <h2 id={`${searchId}-title`} ref={heading} tabIndex={-1} className="visually-hidden">People and agents</h2>
    <div className="k42-directory-controls">
      {onKind && <DirectoryChips counts={counts} kind={kind} onKind={onKind} />}
      <SearchField id={searchId} className="k42-directory-search-field" label={serverSearch ? 'Find agent names starting with' : 'Search this page'} value={query} maxLength={serverSearch ? 40 : 80} placeholder={serverSearch ? 'Agent name starts with' : 'Search this page'} onChange={event => serverSearch ? onAgentQuery?.(event.target.value) : setSearch(event.target.value)} />
    </div>
    {(['people', 'agents'] as const).filter(lane => kind === 'all' || kind === lane).map(lane => paging?.[lane].error && <p key={lane} className="error" role="alert">Could not refresh {lane}: {paging[lane].error}</p>)}
    {loading && !shown.length && !(['people', 'agents'] as const).some(lane => (kind === 'all' || kind === lane) && paging?.[lane].error) ? <p className="muted" role="status">Loading people and agents…</p>
      : !shown.length ? <EmptyState icon={query ? Search : Users} size="compact" title={query ? 'No matches on this page.' : noAgents ? 'No agents yet.' : 'No entries on this page.'}
        action={query ? <Button type="button" onClick={() => serverSearch ? onAgentQuery?.('') : setSearch('')}>Clear search</Button> : undefined}>{query ? 'Try another name or page.' : noAgents ? 'Ask your coding agent to add one to this project.' : 'Change the filter or continue with the page controls when available.'}</EmptyState>
      : <ul className="k42-directory-list">{shown.map(entry => <li key={`${entry.kind}:${entry.id}`} data-avatar-poke-scope="">
        {/* One card for people and agents alike (owner, 19 October 2026): photo, name, what they are, then a details line. */}
        <NavLink to={entry.kind === 'person' ? projectRoute(projectId, 'agents', null, null) : projectRoute(projectId, 'agents', entry.id, agentQuery || null)} go={go} className="k42-directory-card">
          <span className="k42-directory-photo">{entry.kind === 'person' ? <PersonAvatar id={entry.id} photo={entry.photo} character={entry.character} name={entry.name} /> : <CodingAgentAvatar state={entry.state} provider={entry.provider} name={entry.name} id={entry.id} persona={entry.personaChoice} ownerName={entry.ownerName} ownerId={entry.ownerId} size={56} decorative />}
            {entry.kind === 'agent' && <AgentStatusIcon state={entry.state} overlay />}</span>
          <span className="k42-directory-text"><strong>{entry.name}</strong>
            <small>{entry.kind === 'person' ? entry.owner ? 'Owner' : 'Member' : entry.ownerName ? `Agent of ${entry.ownerName}` : 'Agent'}</small></span>
          {entry.kind === 'person' ? <div className="k42-directory-meta">{`${entry.agents} loaded ${entry.agents === 1 ? 'agent' : 'agents'}`}</div>
            : <AgentCardDetails state={entry.state} status={entry.status} agent={agents.find(a => a.id === entry.id)} now={now} />}
        </NavLink>
        <AvatarPokeButton name={entry.name} className="k42-directory-poke" />
        {entry.kind === 'agent' && agentActions?.(entry.id)}
      </li>)}</ul>}
    {(['people', 'agents'] as const).filter(lane => kind === 'all' || kind === lane).map(lane => {
      const page = paging?.[lane];
      return page && (!page.first || page.hasNext) ? <nav key={lane} aria-label={`${lane === 'people' ? 'People' : 'Agents'} pages`}>
        <p className="muted">{lane === 'people' ? 'People' : 'Agents'} pages</p>
        <Pager first={page.first} hasNext={page.hasNext} onBack={() => { heading.current?.focus(); page.onBack(); }} onNext={() => { heading.current?.focus(); page.onNext(); }} nextLabel={`More ${lane}`} />
      </nav> : null;
    })}
  </section>;
}

const LIVE: CommunicationAgentState[] = ['working', 'talking', 'idle', 'waiting', 'needs_you', 'blocked', 'pausing', 'pause_unconfirmed'];
/** An agent card's footer (owner, 14 November 2026): its status, its own focus as the headline, then its current or last task. */
function AgentCardDetails({ state, status, agent, now }: { state: CommunicationAgentState; status: string; agent?: DirectoryAgent; now: number }) {
  const focus = agent?.focus, task = agent?.task, live = LIVE.includes(state);
  return <div className="k42-directory-meta is-agent">
    <span className={`k42-agent-chip state-${state}`}><AgentStateSymbol state={state} size={13} strokeWidth={2.2} aria-hidden="true" />{status}</span>
    {focus ? <p className={`k42-directory-focus${live ? '' : ' is-stale'}`} title={focus.text}>{focus.text}</p>
      : <p className="k42-directory-focus is-empty">No focus reported yet</p>}
    {focus && <small className="k42-directory-when">{live ? 'Focus' : 'Last focus'} · {ago(focus.updatedAt, now) ?? time(focus.updatedAt, false)}</small>}
    {task && <p className="k42-directory-task" title={task.title}><span className="k42-directory-task-kind">{task.status === 'in_progress' ? 'Current task' : 'Last task'}</span>
      <span className="k42-directory-task-title">{task.title}</span><span className={`k42-task-status is-${task.status}`}>{statusLabel(task.status)}</span></p>}
  </div>;
}
