import { AgentStatusIcon } from './AgentStatusIcon';
import { useEffect, useRef, useState } from 'react';
import type { SessionUser } from '../session-identity';
import type { ProjectWorkersView } from '@mlswarm/contracts';
import { ApiError, session, owner, ownOwner } from '../api';
import { agentPlayState, repeatExecution, type PlayState } from './agent-play-state';
import { workerAgentStatus } from './agent-running-state';
import { Pause, Play } from 'lucide-react';
import { Button } from './Button';
import { BackgroundWorkerActions } from './BackgroundWorkerControls';
import { useMyWorkers, type MyWorkers } from './MyWorkerControls';
import type { Computer } from './ComputerSetup';
import './agent-run-controls.css';

type Worker = ProjectWorkersView['agents'][number];


// Play for a stopped agent: queues a new run for this same agent on the computer it last ran on. It works toward
// the project's goal until it is paused or killed, or the job's token cap is reached; the person steers it from there.
export function PlayAgent({ user, projectId, agent, disabled, refresh, compact = false }: { user: SessionUser; projectId: string; agent: Worker; disabled: boolean; refresh: () => void; compact?: boolean }) {
  const [state, setState] = useState<PlayState>({ pending: null, busy: false, error: null });
  const controller = useRef<ReturnType<typeof agentPlayState> | null>(null);
  const latest = useRef({ agent, refresh }); latest.current = { agent, refresh };
  useEffect(() => {
    const current = agentPlayState({
      key: `mlswarm-agent-play:${user.uid}:${projectId}:${agent.agentId}`, projectId, agentId: agent.agentId,
      storage: sessionStorage, authorized: () => session.currentUid() === user.uid,
      prepare: async () => {
        const { computers } = await owner<{ computers: Computer[] }>(user, '/computers');
        const row = latest.current.agent;
        return { id: crypto.randomUUID(), projectId, agentId: row.agentId, name: row.agentName,
          ...repeatExecution(row.run, computers, Date.now()), approved: true };
      },
      send: async request => {
        const account = await owner<{ profileId: string }>(user, '/profile');
        if (session.currentUid() !== user.uid) throw new Error('Sign in again before retrying.');
        return ownOwner(user, account.profileId, '/web-agent-starts', request);
      },
      refused: failure => failure instanceof ApiError && failure.status >= 400 && failure.status < 500 && ![408, 429].includes(failure.status),
      changed: setState, accepted: () => latest.current.refresh(),
    });
    controller.current = current; setState(current.snapshot());
    return () => { current.dispose(); if (controller.current === current) controller.current = null; };
  }, [user, projectId, agent.agentId]);
  const { busy, error, pending } = state;
  return <span className="k42-play-agent">
    <Button type="button" className={compact && !pending ? 'soft k42-run-icon' : 'soft'} disabled={busy || disabled} aria-label={`${pending ? 'Retry starting' : 'Start'} ${agent.agentName}`} title={pending ? 'Retry start' : 'Start'} onClick={() => void controller.current?.start()}>{busy ? 'Starting…' : pending ? 'Retry start' : compact ? <Play size={14} aria-hidden="true" /> : 'Start'}</Button>
    {error && <small className="error" role="alert">{error}</small>}
  </span>;
}

// Play or Pause, whichever applies now.
export function AgentRunActions({ user, projectId, agent, controls, now, disabled, compact = false }: { user: SessionUser; projectId: string; agent: Worker; controls: MyWorkers; now: number; disabled: boolean; compact?: boolean }) {
  const status = workerAgentStatus(agent, now);
  if (controls.data?.projectClosed) return null;
  if (agent.projectPause && compact) return null; // Project Resume cannot be replaced by an individual agent Resume.
  if (status.label === 'Stopped') return <PlayAgent user={user} projectId={projectId} agent={agent} disabled={disabled} refresh={controls.refresh} compact={compact} />;
  const background = agent.backgroundControl?.target.agentId === agent.agentId && agent.backgroundControl.target.projectId === projectId ? agent.backgroundControl : null;
  if (compact) {
    if (!background || !['Working', 'Idle', 'Paused'].includes(status.label)) return null;
    const paused = status.label === 'Paused';
    return <Button type="button" className="soft k42-run-icon" disabled={disabled || !!controls.background.busy[agent.agentId] || !!controls.background.pending[agent.agentId] || !!background.pending && ['queued', 'accepted'].includes(background.pending.state) || !background.available || now - background.deviceLastSeenAt >= 90000 || paused && !background.pauseOperationId}
      aria-label={`${paused ? 'Resume' : 'Pause'} ${agent.agentName}`} title={paused ? 'Resume' : 'Pause'}
      onClick={() => void controls.background.act(agent.agentId, background, paused ? 'resume' : 'pause')}>{paused ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />}</Button>;
  }
  return <BackgroundWorkerActions agentId={agent.agentId} agentName={agent.agentName} view={background} controls={controls.background} now={now} disabled={disabled} />;
}

// The agent's own page: status and Play/Pause.
export function AgentRunPanel({ user, projectId, agentId }: { user: SessionUser; projectId: string; agentId: string }) {
  const controls = useMyWorkers();
  const agent = controls?.data?.agents.find(a => a.agentId === agentId);
  if (!controls || !agent) return null;
  const status = workerAgentStatus(agent, controls.now);
  return <div className="k42-agent-run" title={status.title}>
    <strong className="k42-agent-status-text"><AgentStatusIcon label={status.label} decorative />{status.label}</strong>
    {['Waiting', 'Idle'].includes(status.label) && <span className="muted"> · {status.title}</span>}
    <AgentRunActions user={user} projectId={projectId} agent={agent} controls={controls} now={controls.now} disabled={false} />
  </div>;
}
