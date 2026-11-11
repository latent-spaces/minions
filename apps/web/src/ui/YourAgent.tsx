import { Button } from './Button';
import type { ProjectWorkersView } from '@mlswarm/contracts';
import { CloseButton } from './CloseButton';
import { RemoveAgent } from './RemoveAgent';
import { Dialog } from './Dialog';
import { createPortal } from 'react-dom';
import type { SessionUser } from '../session-identity';
import { useContext, useEffect, useId, useRef, useState } from 'react';
import { platform, ProjectScope } from '../api';
import { useMyWorkers } from './MyWorkerControls';
import { NavLink } from '../shared';
import { projectRoute, type Route } from '../route';
import { runEndLine } from '../run-end';
import './your-agent.css';
import { changeLimitsInstructions } from '../setup-instruction';
import { AnotherComputer, PromptBox, SetupCard, useComputers } from './ComputerSetup';
import { AgentObservationList } from './AgentObservationList';
import { Bot } from 'lucide-react';
import { EmptyState } from './EmptyState';

// An agent's limits: how involved its operator wants to be. How long it works is the job's end time, set for
// the whole project. Limits are chosen in the
// coding agent, in the question it asks before the agent starts, and shown here read-only.
type Limits = ProjectWorkersView['agents'][number]['settings'];
const describeLimits = (limits: Limits) => limits.involvement === 'with_me' ? 'with you in your conversation' : 'on its own';

// untilConnected: the join page shows this card only until one of the person's agents has made contact.
export function YourAgent({ user, tick, refresh, active, projectName, untilConnected = false, go, readOnly = false }: { projectName: string, user: SessionUser, tick: number, refresh: () => void, active: boolean, untilConnected?: boolean, go?: (to: Route) => void, readOnly?: boolean }) {
  const projectId = useContext(ProjectScope);
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const workers = useMyWorkers();
  const data = workers?.data;
  // The agent whose limits prompt the dialog shows.
  const [limitsFor, setLimitsFor] = useState<string | null>(null);
  // Without an approved computer the dialog shows the setup prompt instead: one prompt at a time.
  const { computers, error: computersError } = useComputers(user, active && !readOnly, tick);
  // Agents one person may have in a project; shown so the limit is never a surprise.
  const [agentLimit, setAgentLimit] = useState<number | null>(null);
  useEffect(() => { let current = true; platform<{ maxAgentsPerParticipant: number }>(user, '/limits').then(value => { if (current) setAgentLimit(value.maxAgentsPerParticipant); }, () => {}); return () => { current = false; }; }, [user]);
  useEffect(() => { dialog.current?.close(); }, [projectId, user.uid]);
  useEffect(() => { if (!active) dialog.current?.close(); }, [active]);
  const open = (agentName: string) => { setLimitsFor(agentName); dialog.current?.showModal(); };
  const agents = data?.agents ?? [], queued = data?.queued ?? [];
  if (untilConnected && (!data || agents.some(agent => agent.worker.session || agent.backgroundControl))) return null;
  return <section className="your-agent" aria-label="My agents">
    <div className="agent-connect-card">
      {data && <div className="agent-connections-heading"><h3>Your agents</h3></div>}
      {data && agentLimit !== null && !readOnly && <p className="muted agent-limit-line">{agents.length} of {agentLimit} agents per person in this project.{agents.length === agentLimit - 1 ? ' You can add one more.' : agents.length >= agentLimit ? ' Remove one to add another.' : ''}</p>}
      {!data && !workers?.error && <p className="muted" role="status">Loading your agents…</p>}
      {workers?.error && <p className="error" role="alert">{workers.error}</p>}
      {data && !agents.length && !queued.length && <div className="agent-empty">
        <EmptyState icon={Bot} size="large" title="You have no agents here yet">{readOnly ? 'This project is closed, so no new agents can join.' : <>Ask your local coding agent to add an agent to {projectName} through MyLittleSwarm MCP.</>}</EmptyState>
      </div>}
      {!!(agents.length || queued.length) && <AgentObservationList agents={agents} queued={queued} now={workers!.now}
        name={agent => go ? <NavLink to={projectRoute(projectId, 'agents', agent.agentId)} go={go}><strong>{agent.agentName}</strong></NavLink> : <strong>{agent.agentName}</strong>}
        details={(agent, status) => <>{status.label === 'Stopped' && <p className="muted">{runEndLine(agent.lastRun) || status.title}</p>}
          <p className="muted">Limits: works {describeLimits(agent.settings)}. You change them in your coding agent.</p></>}
        actions={readOnly ? undefined : agent => <div className="actions">
          <Button onClick={() => open(agent.agentName)}>Change limits</Button>
          <RemoveAgent user={user} projectId={projectId} agentId={agent.agentId} agentName={agent.agentName} onRemoved={refresh} />
        </div>} />}
    </div>
    {/* Limits are changed in the coding agent: the dialog hands over what to paste there. */}
    {!readOnly && createPortal(<Dialog ref={dialog} className="agent-connect-dialog" aria-labelledby={titleId}>
      <div className="k42-contrib-body">
      <div className="agent-connections-heading"><h2 id={titleId}>Change {limitsFor}’s limits</h2><CloseButton onClick={() => dialog.current?.close()} /></div>
      {computers === null ? (computersError ? <div role="alert"><p className="error">Could not load your computers: {computersError}</p><Button className="soft" onClick={refresh}>Try again</Button></div> : <p className="muted" role="status">Loading…</p>)
      : computers.length === 0 ? <SetupCard />
      : <><AnotherComputer />
      {limitsFor && <><p>Paste this into your coding agent.</p><PromptBox prompt={changeLimitsInstructions(limitsFor, projectName)} label={`Prompt for ${limitsFor}`} /></>}
      </>}
      </div>
    </Dialog>, document.body)}
  </section>;
}
