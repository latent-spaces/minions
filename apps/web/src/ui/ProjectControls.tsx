import { useEffect, useId, useRef, useState } from 'react';
import { RUN_LENGTH, runLengthLabel } from '@mlswarm/contracts';
import { RunLengthChoice } from './RunLengthChoice';
import type { SessionUser } from '../session-identity';
import type { Workspace } from '../project-api';
import { ApiError, projects } from '../api';
import { hold } from '../route';
import { Button } from './Button';
import { confirmAction } from './Confirm';
import { notify } from './Toast';
import { Pause, Play, Plus, RotateCcw, Archive } from 'lucide-react';
import './project-controls.css';
import './agent-run-controls.css';
import { useLifecycleFeedback } from './LifecycleFeedback';
import { useMyWorkerControls } from './MyWorkerControls';

type Action = 'start' | 'pause' | 'resume' | 'close' | 'reopen' | 'add_time' | 'set_tokens';
type Pending = { client_request_id: string; expected_revision: number; action: Action; start_without_minimum?: true; minutes?: number; tokens?: number | null };
const labels: Record<Action, string> = { start: 'Start project', pause: 'Pause project', resume: 'Resume project', close: 'Close project', reopen: 'Reopen project', add_time: 'Add time', set_tokens: 'Set token cap' };
const confirmations: Record<Action, string> = {
  start: 'Start the project. Agents waiting for it start working, until the time you chose is up.',
  pause: 'Each agent finishes its current turn, then waits. Wait for each agent to confirm it has paused. Chat stays open.',
  resume: 'Agents carry on until the job’s end time.',
  close: 'Closing stops every agent in this project, including work in progress and agents working in a chat. The project becomes read-only; its history stays, and you can reopen it later.',
  reopen: 'Chat and editing come back. Work starts again when you start it.',
  add_time: '',
  set_tokens: '',
};
const notices: Record<Action, string> = { start: 'Project started.', pause: 'Pause requested. Waiting for agent feedback.', resume: 'Project resumed.', close: 'Project closed. All its agents stopped.', reopen: 'Project reopened. Start work when you’re ready.', add_time: 'Time added.', set_tokens: '' };

const keepsSchedule = (workspace: Workspace) => !workspace.privacy && workspace.listed === true && !workspace.project?.started && !!workspace.project && workspace.setup?.finalizedAt != null && !!workspace.setup.startDeadline;
const reopenScheduleNotice = 'The saved start date still applies. If it has passed, the project starts in a moment.';

// One request identity and lock per project/account, shared with lifecycle feedback.
export function useProjectControls(user: SessionUser, workspace: Workspace | null, refresh: () => void, active = true, onClosed?: () => void) {
  const inviteFeedback = useLifecycleFeedback();
  const workers = useMyWorkerControls(user, workspace?.id ?? null, active);
  const [pending, setPending] = useState<Pending | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const lock = useRef(false);
  useEffect(() => pending || busy ? hold() : undefined, [pending, busy]);
  async function execute(input: Pending) {
    if (!workspace || lock.current) return false;
    lock.current = true; setPending(input); setBusy(true); setError('');
    try {
      await projects(user, `/${workspace.id}/control`, input);
      // The job bar shows its own Saved for the token cap.
      setPending(null); if (!['start', 'set_tokens'].includes(input.action)) notify(input.action === 'add_time' ? `${runLengthLabel(input.minutes!)} added. Waiting agents continue.` : input.action === 'reopen' && keepsSchedule(workspace) ? `Project reopened. ${reopenScheduleNotice}` : notices[input.action], input.action === 'close' ? 'info' : 'success'); refresh();
      // A closed project leaves the person on My projects, where it now sits under Closed (owner, 19 October 2026).
      // Release the action's navigation hold before returning to My projects and opening feedback.
      if (input.action === 'close') window.setTimeout(() => { onClosed?.(); inviteFeedback('close'); }, 150);
      if (input.action === 'pause') inviteFeedback('pause');
      return true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not confirm the project action.');
      if (failure instanceof ApiError && failure.status >= 400 && failure.status < 500 && ![408, 429].includes(failure.status)) { setPending(null); refresh(); }
      return false;
    } finally { lock.current = false; setBusy(false); }
  }
  // minutes: the job length chosen for Start, or the time to add. Adding time needs no second confirmation.
  async function act(action: Action, minutes?: number) {
    if (!workspace || lock.current || pending) return;
    // Lock before opening the shared confirmation, including the card on the hidden tab.
    lock.current = true; setBusy(true);
    try {
      const belowMinimum = action === 'start' && !!workspace.setup?.required && (workspace.participantCount ?? 0) < (workspace.setup.minContributors ?? 1);
      if (belowMinimum && workspace.role !== 'owner') return;
      const message = belowMinimum ? `Only ${workspace.participantCount ?? 0} people have joined, below the minimum of ${workspace.setup!.minContributors}. Start with fewer?` : action === 'reopen' && keepsSchedule(workspace) ? `Restore discussion and editing. ${reopenScheduleNotice}` : confirmations[action];
      if (action !== 'add_time' && !await confirmAction(message, belowMinimum ? 'Start with fewer' : labels[action])) return;
      const input: Pending = { client_request_id: crypto.randomUUID(), expected_revision: workspace.revision, action, ...(belowMinimum ? { start_without_minimum: true as const } : {}), ...(minutes !== undefined ? { minutes } : {}) };
      lock.current = false;
      await execute(input);
    } finally { lock.current = false; setBusy(false); }
  }
  // The job's token cap, one pool for all the owner's agents in the project; null removes it. No confirmation.
  const setTokens = (tokens: number | null) => !workspace || lock.current || pending ? Promise.resolve(false)
    : execute({ client_request_id: crypto.randomUUID(), expected_revision: workspace.revision, action: 'set_tokens', tokens });
  return { workers, pending, busy, error, locked: busy || pending !== null, act, setTokens, retry: () => pending && execute(pending), discard: () => { if (!lock.current) { setPending(null); setError(''); refresh(); } } };
}
export type ProjectControls = ReturnType<typeof useProjectControls>;

export function ProjectControlsCard({ workspace, controls, disabled = false }: { workspace: Workspace; controls: ProjectControls; disabled?: boolean }) {
  const titleId = useId();
  if (workspace.role !== 'owner') return null;
  const closed = workspace.execution === 'closed', started = !!workspace.project?.started, paused = !!workspace.project?.paused;
  const primary: Action = closed ? 'reopen' : !started ? 'start' : paused ? 'resume' : 'pause';
  const missingSetup = !workspace.project || !!workspace.setup?.required && !workspace.setup.finalizedAt;
  const belowMinimum = !started && !!workspace.setup?.required && (workspace.participantCount ?? 0) < (workspace.setup.minContributors ?? 1);
  const primaryDisabled = disabled || controls.locked || primary === 'start' && (missingSetup || belowMinimum && workspace.role !== 'owner');
  const status = closed ? 'Closed' : started ? paused ? 'Paused' : 'Running' : missingSetup ? 'Setup needed' : belowMinimum ? 'Recruiting' : 'Ready to start';
  const help = closed ? keepsSchedule(workspace) ? `History is kept. Reopen to bring back chat and editing. ${reopenScheduleNotice}` : 'History is kept. Reopen to bring back chat and editing.' : started ? paused ? 'Pause requested. Check agent confirmations on Home. Chat stays open.' : 'Pause lets each agent finish its current turn, then waits for confirmation. Discussion stays open.' : !workspace.project ? 'Chat is available. Add a repository in Control center → Repository before starting agent work.' : missingSetup ? 'Publish the project from Control center → Discoverability before starting work.' : workspace.setup?.startDeadline && workspace.listed ? 'Starts by itself on its date. You can start earlier.' : belowMinimum ? workspace.role === 'owner' ? 'You can wait for more people or start with fewer.' : 'Waiting for the minimum number of people. Only the owner can start with fewer.' : 'Start enables approved work when your team is ready.';
  const PrimaryIcon = primary === 'pause' ? Pause : primary === 'reopen' ? RotateCcw : Play;
  return <section className="project-controls-card" aria-labelledby={titleId}>
    <div className="project-controls-heading"><h2 id={titleId}>Project status</h2><span className="project-controls-role">Owner</span></div>
    <div className="project-controls-body">
      <div className="project-controls-status"><strong>{status}</strong><p>{help}</p></div>
      <div className="project-controls-actions">
        {primary === 'start' ? <StartProject id={`${titleId}-length`} disabled={primaryDisabled} controls={controls} className="primary" />
          : <Button className={primary === 'pause' || primary === 'reopen' ? 'outline' : 'primary'} disabled={primaryDisabled} onClick={() => void controls.act(primary)}><PrimaryIcon size={16} aria-hidden="true" />{labels[primary]}</Button>}
      </div>
    </div>
    {!closed && <section className="project-controls-close-section"><h3>Close project</h3><p>Stops every agent in this project and makes it read-only. History is kept, and you can reopen it later.</p><Button className="outline" disabled={disabled || controls.locked} onClick={() => void controls.act('close')}><Archive size={16} aria-hidden="true" />Close project</Button></section>}
  </section>;
}

/** Start takes the job's length, preset to the default hour; the person can change it before starting. */
export function StartProject({ id, controls, disabled, className }: { id: string; controls: ProjectControls; disabled: boolean; className: string }) {
  const [minutes, setMinutes] = useState<number | null>(RUN_LENGTH.defaultMinutes);
  return <span className="k42-play-agent">
    <RunLengthChoice id={id} label="How long should agents work?" value={minutes} onChange={setMinutes} disabled={disabled} />
    <Button type="button" className={className} disabled={disabled || minutes === null} title={minutes === null ? 'Choose how long agents should work first' : undefined} onClick={() => void controls.act('start', minutes!)}><Play size={16} aria-hidden="true" />Start project</Button>
  </span>;
}

/** Add time to the job, for every agent at once. Nothing is preselected. */
export function AddProjectTime({ id, controls, disabled, className }: { id: string; controls: ProjectControls; disabled: boolean; className: string }) {
  const [open, setOpen] = useState(false), [minutes, setMinutes] = useState<number | null>(null);
  if (!open) return <Button type="button" className={className} disabled={disabled} title="Moves the end time for every agent in this project. Only the owner can do this." onClick={() => setOpen(true)}><Plus size={16} aria-hidden="true" />Add time</Button>;
  return <span className="k42-play-agent">
    <RunLengthChoice id={id} label="Add" value={minutes} onChange={setMinutes} disabled={disabled} />
    <Button type="button" className={className} disabled={disabled || minutes === null} onClick={() => { void controls.act('add_time', minutes!); setOpen(false); setMinutes(null); }}>Add</Button>
    <Button type="button" className={className} onClick={() => { setOpen(false); setMinutes(null); }}>Cancel</Button>
  </span>;
}

/** One visible receipt surface shared by every project tab, including closed projects. */
export function ProjectControlFeedback({ controls, disabled = false }: { controls: ProjectControls; disabled?: boolean }) {
  return <>
    {controls.error && <p className="error" role="alert">{controls.error}</p>}
    {controls.pending && !controls.busy && <div className="project-controls-retry"><p>This action wasn’t confirmed. Retry the same request before starting another.</p><div className="project-controls-actions"><Button disabled={disabled} onClick={() => void controls.retry()}>Retry {labels[controls.pending.action].toLowerCase()}</Button><Button className="soft" onClick={controls.discard}>Discard request and reload</Button></div></div>}
  </>;
}

/** Who may start work now: only the owner (one person, owner decision 10 November 2026). Null when there is nothing to start: closed, already started, or still being set up. */
export function startWork(workspace: Workspace): { canStart: boolean; owner: boolean; scheduled: string | null } | null {
  if (workspace.execution === 'closed' || workspace.project?.started || !workspace.project) return null;
  if (workspace.setup?.required && !workspace.setup.finalizedAt) return null;
  const owner = workspace.role === 'owner';
  const scheduled = workspace.listed && workspace.setup?.startDeadline ? new Date(workspace.setup.startDeadline).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : null;
  return { canStart: owner, owner, scheduled };
}
