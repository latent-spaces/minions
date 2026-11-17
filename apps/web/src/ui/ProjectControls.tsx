import { useEffect, useRef, useState } from 'react';
import { RUN_LENGTH, runLengthLabel } from '@minions/contracts';
import { RunLengthChoice } from './RunLengthChoice';
import type { SessionUser } from '../session-identity';
import type { Workspace } from '../project-api';
import { ApiError, projects } from '../api';
import { hold } from '../route';
import { Button } from './Button';
import { confirmAction } from './Confirm';
import { notify } from './Toast';
import { Play } from './icons';
import './project-controls.css';
import './agent-run-controls.css';
import { useMyWorkerControls } from './MyWorkerControls';

type Action = 'start' | 'pause' | 'resume' | 'close' | 'reopen' | 'add_time' | 'set_tokens';
type Pending = { client_request_id: string; expected_revision: number; action: Action; start_without_minimum?: true; minutes?: number; tokens?: number | null };
const labels: Record<Action, string> = { start: 'Start project', pause: 'Pause project', resume: 'Resume agents', close: 'Close project', reopen: 'Reopen project', add_time: 'Add time', set_tokens: 'Set token cap' };
const confirmations: Record<Action, string> = {
  start: 'Start the project. Agents waiting for it start working, until the time you chose is up.',
  pause: 'Each agent finishes its current turn, then waits. Wait for each agent to confirm it has paused. Chat stays open.',
  resume: '',
  close: 'Closing stops every agent in this project, including work in progress and agents working in a chat. The project becomes read-only; its history stays, and you can reopen it later.',
  reopen: 'Chat and editing come back. Work starts again when you start it.',
  add_time: '',
  set_tokens: '',
};
const notices: Record<Action, string> = { start: 'Project started.', pause: 'Pause requested. Waiting for agent feedback.', resume: 'Agents resumed.', close: 'Project closed.', reopen: 'Project reopened. Start work when you’re ready.', add_time: 'Time added.', set_tokens: '' };

// Resume copy (owner, 11 November 2026): says where agents pick up and when the job ends.
const resumeMessage = (workspace: Workspace) => workspace.endsAt && workspace.endsAt > Date.now()
  ? `Agents pick up where they stopped and keep working until the job ends at ${new Date(workspace.endsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`
  : 'Agents pick up where they stopped and keep working until the job ends.';
const keepsSchedule = (workspace: Workspace) => !workspace.privacy && workspace.listed === true && !workspace.project?.started && !!workspace.project && workspace.setup?.finalizedAt != null && !!workspace.setup.startDeadline;
const reopenScheduleNotice = 'The saved start date still applies. If it has passed, the project starts in a moment.';

// One request identity and lock per project/account.
export function useProjectControls(user: SessionUser, workspace: Workspace | null, refresh: () => void, active = true, onClosed?: () => void) {
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
      // Release the action's navigation hold before returning to My projects.
      if (input.action === 'close') window.setTimeout(() => onClosed?.(), 150);
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
      const message = action === 'resume' ? resumeMessage(workspace) : belowMinimum ? `Only ${workspace.participantCount ?? 0} people have joined, below the minimum of ${workspace.setup!.minContributors}. Start with fewer?` : action === 'reopen' && keepsSchedule(workspace) ? `Restore discussion and editing. ${reopenScheduleNotice}` : confirmations[action];
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

/** Start takes the job's length, preset to the default hour; the person can change it before starting. */
export function StartProject({ id, controls, disabled, className }: { id: string; controls: ProjectControls; disabled: boolean; className: string }) {
  const [minutes, setMinutes] = useState<number | null>(RUN_LENGTH.defaultMinutes);
  return <span className="k42-play-agent">
    <RunLengthChoice id={id} label="How long should agents work?" value={minutes} onChange={setMinutes} disabled={disabled} />
    <Button type="button" className={className} disabled={disabled || minutes === null} title={minutes === null ? 'Choose how long agents should work first' : undefined} onClick={() => void controls.act('start', minutes!)}><Play size={16} aria-hidden="true" />Start project</Button>
  </span>;
}

/** One visible receipt surface shared by every project tab, including closed projects. */
export function ProjectControlFeedback({ controls }: { controls: ProjectControls }) {
  return <>
    {controls.error && <p className="error" role="alert">{controls.error}</p>}
    {controls.pending && !controls.busy && <div className="project-controls-retry"><p>This action wasn’t confirmed. Retry the same request before starting another.</p><div className="project-controls-actions"><Button onClick={() => void controls.retry()}>Retry {labels[controls.pending.action].toLowerCase()}</Button><Button className="soft" onClick={controls.discard}>Discard request and reload</Button></div></div>}
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
