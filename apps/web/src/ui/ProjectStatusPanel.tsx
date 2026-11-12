import { useEffect, useId, useState, type ReactNode } from 'react';
import { Archive, CircleAlert, Hourglass, Pause, Play, RotateCcw } from 'lucide-react';
import type { Workspace } from '../project-api';
import { Button } from './Button';
import { Tooltip } from './Tooltip';
import { StartProject, startWork, type ProjectControls } from './ProjectControls';
import { timeLeft } from '../observation-time';
import './project-header.css';
import './project-status-panel.css';

/**
 * Home's project status panel (Noa, 26 October 2026): the project's state on one line. Only the owner
 * starts, pauses or resumes the whole project (owner decision, 27 October 2026). Pause, Resume, Close and Reopen are
 * icon buttons with a hover label here, not a Settings card (owner, 12 November 2026). A requested pause links to Updates, where the map holds the per-agent confirmations.
 * The job has one end time for every agent (owner decision, 9 November 2026). The owner sees it and adds time in one
 * place, the job bar above My agents (owner decision, 10 November 2026); the panel shows the end time and the time
 * left only to people who do not see that bar. When time is up agents are not ended: they finish their turn and wait.
 */
export function ProjectStatusPanel({ workspace, controls }: { workspace: Workspace; controls: ProjectControls }) {
  const titleId = useId();
  const closed = workspace.execution === 'closed', started = !!workspace.project?.started, paused = !!workspace.project?.paused;
  const manager = workspace.role === 'owner';
  const waiting = startWork(workspace);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  const endsAt = workspace.endsAt ?? null, showTime = started && !closed && !manager, timeUp = showTime && (endsAt === null || endsAt <= now);
  // A running project says nothing about itself; only the states that change what you can do are named (owner, 11 November 2026).
  const status = closed ? 'Closed' : !started ? manager ? 'Ready to start' : 'Waiting for the owner to start' : paused ? 'Paused' : null;
  const help = closed ? 'Read-only. History is kept.'
    : paused ? 'Agents take no new turns. Chat stays open.'
    : timeUp ? 'Agents finish their turn, then wait until the owner adds time.'
    : started ? null
    : manager && !workspace.project ? 'Add a repository through your coding agent before starting.'
    : manager && workspace.setup?.required && !workspace.setup.finalizedAt ? 'Publish the project before starting work.'
    : waiting?.scheduled ? `Starts by itself on ${waiting.scheduled}.`
    : null;
  const Icon = closed ? Archive : !started ? Hourglass : paused ? Pause : null;
  const canStart = !!startWork(workspace)?.canStart;
  const projectAction = manager && started && !closed ? paused ? 'resume' as const : 'pause' as const : null;
  return <section className="k42-status-panel" aria-labelledby={titleId}>
    <h2 id={titleId} className="visually-hidden">Project status</h2>
    <div className="k42-status-line">
      {Icon && <span className="k42-notice-icon k42-status-tile" aria-hidden="true"><Icon size={20} /></span>}
      {(status || showTime || help) && <div className="k42-status-text">
        {(status || showTime) && <strong>{status}
          {showTime && <>{status && ' · '}{timeUp ? <span className="k42-status-time">Time is up</span>
            : <span className="k42-status-time" title={`The job ends ${new Date(endsAt!).toLocaleString()}`}>{timeLeft(endsAt! - now)} · ends {new Date(endsAt!).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>}</>}</strong>}
        {help && <span>{help}</span>}
      </div>}
      <div className="k42-status-actions">
        {/* Start lives here, with the project's status (Noa, 26 October 2026). */}
        {canStart && <StartProject id={`${titleId}-length`} className="k42-ph-thin" disabled={controls.locked} controls={controls} />}
        {projectAction && <HeaderIcon label={projectAction === 'pause' ? 'Pause all agents' : 'Resume all agents'} tip={projectAction === 'pause' ? 'Each agent finishes its turn, then waits.' : 'Agents pick up where they stopped.'} disabled={controls.locked} onClick={() => void controls.act(projectAction)}>
          {projectAction === 'pause' ? <Pause size={18} aria-hidden="true" /> : <Play size={18} aria-hidden="true" />}</HeaderIcon>}
        {manager && !closed && <HeaderIcon label="Close project" tip="Stops every agent and makes the project read-only. You can reopen it." disabled={controls.locked} onClick={() => void controls.act('close')}><Archive size={18} aria-hidden="true" /></HeaderIcon>}
        {manager && closed && <HeaderIcon label="Reopen project" tip="Brings back chat and editing." disabled={controls.locked} onClick={() => void controls.act('reopen')}><RotateCcw size={18} aria-hidden="true" /></HeaderIcon>}
      </div>
    </div>
    {paused && !closed && workspace.project?.pauseRequest && <p className="k42-status-pause"><CircleAlert size={16} aria-hidden="true" />Pause requested. Confirmations show on the map.</p>}
  </section>;
}

function HeaderIcon({ label, tip, disabled, onClick, children }: { label: string; tip: string; disabled: boolean; onClick: () => void; children: ReactNode }) {
  return <Tooltip label={`${label}. ${tip}`} side="bottom" wrap><Button type="button" className="k42-ph-icon" aria-label={label} disabled={disabled} onClick={onClick}>{children}</Button></Tooltip>;
}
