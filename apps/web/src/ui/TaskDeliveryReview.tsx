import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { DeliveryReviewEvent, DeliveryReviewMutation, DeliveryReviewRequiredCheck, DeliveryReviewState, NativeTaskActor } from '@minions/contracts';
import { isSettledRefusal, type TasksApi } from '../task-model';
import { Button } from './Button';

const checkLabels = { verified: 'Verified', pending: 'Pending', failed: 'Failed', stale: 'Pull request is stale', unavailable: 'Unavailable' };
const blankCheck = { name: '', workflowId: 0, workflowPath: '', workflowBlobSha: '' };

export function TaskDeliveryReview({ taskId, review, configure, refresh, agents, actorName, read, save, reload, onRefreshPendingChange }: {
  taskId: string;
  review: DeliveryReviewState | undefined;
  configure: boolean;
  refresh: boolean;
  agents: { id: string; name: string; revokedAt: number | null }[];
  actorName: (actor: NativeTaskActor) => string;
  read: TasksApi['getDeliveryReview'];
  save: TasksApi['mutateDeliveryReview'];
  reload: (reportError?: boolean) => Promise<boolean>;
  onRefreshPendingChange: (pending: boolean) => void;
}) {
  const heading = useId();
  const candidate = review?.current;
  const verdict = review?.verdict;
  const observation = review?.observation;
  const githubStatus = observation?.status === 'stale' ? (observation.staleReason === 'closed' ? 'Pull request closed' : 'Pull request head changed')
    : review?.requiredChecks.length === 0 ? 'No required checks configured'
    : observation ? checkLabels[observation.status] : 'Awaiting observation';
  if (!review && (!configure || !save)) return null;
  return <section className="k42-task-section" aria-labelledby={review ? heading : undefined} aria-label={review ? undefined : 'Delivery review'}>
    {review && <h3 id={heading}>Delivery review</h3>}
    {review?.enabled && <>
      {candidate ? <>
        <p>Pull request <a href={`https://github.com/${candidate.repository.split('/').map(encodeURIComponent).join('/')}/pull/${candidate.pullRequest}`}
          rel="noreferrer noopener" target="_blank">{candidate.repository} #{candidate.pullRequest}</a></p>
        <p>Submitted by {actorName(candidate.submittedBy)} at commit <code className="k42-task-evidence-sha">{candidate.headSha}</code></p>
        <details>
          <summary>Delivery manifest</summary>
          <p className="k42-task-description">{candidate.manifest}</p>
        </details>
        {candidate.reportedTests && candidate.reportedTests.length > 0 && <details>
          <summary>Agent-reported test files</summary>
          <ul>{candidate.reportedTests.map(test => <li key={test.path}>{test.path} <code className="k42-task-evidence-sha">{test.sha256}</code></li>)}</ul>
        </details>}
        {verdict ? <>
          <p>Peer verdict on submitted commit · {verdict.verdict === 'approved' ? 'Approved' : 'Changes requested'} · {actorName(verdict.actor)}</p>
          <p className="k42-task-description">{verdict.note}</p>
        </> : <p className="muted">Peer verdict pending{review.reviewerAgentId ? ` · ${actorName({ kind: 'agent', id: review.reviewerAgentId })}` : ''}</p>}
      </> : <p className="muted">Awaiting a pull request and delivery manifest from the assigned agent.</p>}
    </>}
    <RefreshChecks taskId={taskId} generation={refresh && review?.enabled && observation?.status !== 'stale' ? candidate?.generation : undefined}
      save={save} reload={reload} onPendingChange={onRefreshPendingChange}>
      {review?.enabled && candidate && <>
        <p>GitHub checks · {githubStatus}</p>
        {observation && <>
          <p className="muted">Observed {new Date(observation.observedAt).toLocaleString()}
            {observation.status === 'stale' && observation.actualHeadSha && <> · Current head <code className="k42-task-evidence-sha">{observation.actualHeadSha}</code></>}
          </p>
          {observation.checks.length > 0 && <ul>{observation.checks.map(check =>
            <li key={check.name}>{check.jobId && check.runId
              ? <a href={`https://github.com/${candidate.repository}/actions/runs/${check.runId}/job/${check.jobId}`} target="_blank" rel="noopener noreferrer">{check.name}</a>
              : check.name} · {checkLabels[check.status]}</li>)}</ul>}
        </>}
      </>}
    </RefreshChecks>
    {!!review?.failedCheckNames.length && <p>Checks awaiting a passing run · {review.failedCheckNames.join(', ')}</p>}
    {review && !review.enabled && <p className="muted">Delivery review is off.</p>}
    {review && read && <ReviewHistory key={taskId} taskId={taskId} read={read} actorName={actorName} />}
    {configure && save && <DeliveryReviewSettings key={JSON.stringify([review?.enabled, review?.reviewerAgentId, review?.requiredChecks])}
      taskId={taskId} review={review} agents={agents.filter(agent => agent.revokedAt == null)} save={save} reload={reload} />}
  </section>;
}

function ReviewHistory({ taskId, read, actorName }: {
  taskId: string;
  read: NonNullable<TasksApi['getDeliveryReview']>;
  actorName: (actor: NativeTaskActor) => string;
}) {
  const [events, setEvents] = useState<DeliveryReviewEvent[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function load(cursor?: string) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const page = await read(taskId, cursor);
      setEvents(current => cursor ? [...current, ...page.events.filter(event => !current.some(item => item.id === event.id))] : page.events);
      setNext(page.nextCursor);
    } catch (exception) {
      setError(exception instanceof Error ? exception.message : 'Could not read delivery review history.');
      if (exception && typeof exception === 'object' && 'status' in exception && [401, 403, 404].includes(Number(exception.status))) {
        setEvents([]);
        setNext(null);
      }
    } finally {
      setBusy(false);
    }
  }
  return <details onToggle={event => { if (event.currentTarget.open) void load(); }}>
    <summary>Delivery review history</summary>
    {error && <p role="alert" className="error">{error}</p>}
    {busy && <p role="status">Loading review history…</p>}
    <ol className="k42-task-feed">{events.map(event => <li key={event.id} className="k42-task-feed-event">
      <span className="muted">{new Date(event.at).toLocaleString()}</span>{' '}
      <HistorySummary event={event} actorName={actorName} />
    </li>)}</ol>
    {next && <Button disabled={busy} onClick={() => void load(next)}>Show older evidence</Button>}
    {!busy && !error && events.length === 0 && <p className="muted">No events recorded.</p>}
  </details>;
}

function HistorySummary({ event, actorName }: { event: DeliveryReviewEvent; actorName: (actor: NativeTaskActor) => string }) {
  switch (event.kind) {
    case 'configured': return <>{actorName(event.actor)} {event.enabled ? 'updated the delivery review policy' : 'turned off delivery review'}
      {event.enabled && event.requiredChecks.length > 0 && <ul>{event.requiredChecks.map(check => <li key={check.name}>{check.name}</li>)}</ul>}
      {event.reason && <p className="k42-task-description">{event.reason}</p>}</>;
    case 'submitted': return <>Submission {event.generation} by {actorName(event.candidate.submittedBy)} · {event.candidate.repository} #{event.candidate.pullRequest} at <code className="k42-task-evidence-sha">{event.candidate.headSha}</code></>;
    case 'verdict': return <>{actorName(event.verdict.actor)} {event.verdict.verdict === 'approved' ? 'approved' : 'requested changes'} for submission {event.generation}
      <p className="k42-task-description">{event.verdict.note}</p></>;
    case 'observed': return <>GitHub checks for submission {event.generation} · {checkLabels[event.observation.status]}
      {event.observation.actualHeadSha && <> · Head <code className="k42-task-evidence-sha">{event.observation.actualHeadSha}</code></>}
      {event.observation.checks.length > 0 && <ul>{event.observation.checks.map(check =>
        <li key={check.name}>{check.name} · {checkLabels[check.status]}</li>)}</ul>}</>;
    case 'invalidated': return <>{event.reason === 'task_requirements_changed' ? 'Task requirements changed' : 'Task assignment changed'}</>;
  }
}

type RefreshMutation = Extract<DeliveryReviewMutation, { operation: 'refresh' }>;

function RefreshChecks({ taskId, generation, save, reload, onPendingChange, children }: {
  taskId: string;
  generation?: number;
  save: TasksApi['mutateDeliveryReview'];
  reload: (reportError?: boolean) => Promise<boolean>;
  onPendingChange: (pending: boolean) => void;
  children: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<RefreshMutation | null>(null);
  const [receipt, setReceipt] = useState<'saved' | 'replayed' | null>(null);
  const [needsReload, setNeedsReload] = useState(false);
  const protectedWrite = busy || pending !== null;
  useEffect(() => { onPendingChange(protectedWrite); return () => onPendingChange(false); }, [protectedWrite, onPendingChange]);
  const loadCurrent = async () => setNeedsReload(!await reload(false).catch(() => false));

  async function refresh() {
    if (busy || !save) return;
    const mutation: RefreshMutation | null = pending ?? (generation === undefined ? null
      : { operation: 'refresh', taskId, generation, clientRequestId: crypto.randomUUID() });
    if (!mutation) return;
    setBusy(true);
    setError('');
    setReceipt(null);
    try {
      const result = await save(mutation);
      setPending(null);
      setReceipt(result.replayed ? 'replayed' : 'saved');
      await loadCurrent();
    } catch (exception) {
      const settled = isSettledRefusal(exception);
      setPending(settled ? null : mutation);
      setError(exception instanceof Error ? exception.message : 'Could not observe GitHub checks.');
      if (settled && (exception as { status?: number }).status === 409) await reload();
    } finally {
      setBusy(false);
    }
  }
  async function reloadReview() {
    if (busy) return;
    setBusy(true);
    try { await loadCurrent(); }
    finally { setBusy(false); }
  }
  return <>
    {!needsReload && children}
    {needsReload
      ? <Button disabled={busy} onClick={() => void reloadReview()}>{busy ? 'Reloading review…' : 'Reload delivery review'}</Button>
      : save && (pending || generation !== undefined) && <Button disabled={busy} onClick={() => void refresh()}>
        {busy ? 'Checking GitHub…' : pending ? 'Retry refresh' : 'Refresh GitHub checks'}
      </Button>}
    {receipt && <p role="status" className="muted">{receipt === 'replayed' ? 'Recovered the saved refresh receipt.' : 'GitHub check observation saved.'}</p>}
    {needsReload && <p role="alert" className="error">Could not load the current delivery review. Reload it to see the latest evidence.</p>}
    {error && <p role="alert" className="error">{error}</p>}
  </>;
}

type CheckDraft = DeliveryReviewRequiredCheck & { key: number };
type Configure = Extract<Parameters<NonNullable<TasksApi['mutateDeliveryReview']>>[0], { operation: 'configure' }>;

function DeliveryReviewSettings({ taskId, review, agents, save, reload }: {
  taskId: string;
  review: DeliveryReviewState | undefined;
  agents: { id: string; name: string }[];
  save: NonNullable<TasksApi['mutateDeliveryReview']>;
  reload: () => Promise<boolean>;
}) {
  const [enabled, setEnabled] = useState(review?.enabled ?? true);
  const [reviewer, setReviewer] = useState(review?.reviewerAgentId ?? '');
  const [checks, setChecks] = useState<CheckDraft[]>(() => (review?.requiredChecks ?? []).map((check, key) => ({ ...check, key })));
  const nextKey = useRef(checks.length);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<Configure | null>(null);
  const editCheck = (key: number, change: Partial<DeliveryReviewRequiredCheck>) =>
    setChecks(current => current.map(check => check.key === key ? { ...check, ...change } : check));
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const mutation = pending ?? { operation: 'configure', taskId, enabled, expectedGeneration: review?.generation ?? 0,
      ...(enabled ? { reviewerAgentId: reviewer || null } : {}),
      ...(reason.trim() ? { reason: reason.trim() } : {}),
      ...(enabled ? { requiredChecks: checks.map(({ key, ...check }) => check) } : {}), clientRequestId: crypto.randomUUID() };
    setBusy(true);
    setError('');
    try {
      await save(mutation);
      setPending(null);
      await reload();
    } catch (exception) {
      setPending(isSettledRefusal(exception) ? null : mutation);
      setError(exception instanceof Error ? exception.message : 'Could not save delivery review settings.');
      if (isSettledRefusal(exception) && (exception as { status?: number }).status === 409) await reload();
    } finally {
      setBusy(false);
    }
  }
  const reviewerMissing = reviewer && !agents.some(agent => agent.id === reviewer);
  return <details>
    <summary>{review?.enabled ? 'Delivery review settings' : 'Set up delivery review'}</summary>
    <form className="k42-task-evidence-form" onSubmit={event => void submit(event)}>
      <fieldset disabled={busy || !!pending}>
        <label><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} /> Enable delivery review</label>
        {enabled && <>
          <label>Peer reviewer
            <select value={reviewer} onChange={event => setReviewer(event.target.value)}>
              <option value="">Any eligible project agent</option>
              {reviewerMissing && <option value={reviewer}>{reviewer}</option>}
              {agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
            </select>
          </label>
          {checks.map((check, index) => <fieldset key={check.key}>
            <legend>Required check {index + 1}</legend>
            <label>Check name<input required maxLength={150} value={check.name} onChange={event => editCheck(check.key, { name: event.target.value })} /></label>
            <label>Workflow ID<input required type="number" min={1} value={check.workflowId || ''} onChange={event => editCheck(check.key, { workflowId: event.target.valueAsNumber })} /></label>
            <label>Workflow path<input required maxLength={240} placeholder=".github/workflows/ci.yml" value={check.workflowPath} onChange={event => editCheck(check.key, { workflowPath: event.target.value })} /></label>
            <label>Workflow blob SHA<input required pattern="[a-fA-F0-9]{40}" value={check.workflowBlobSha} onChange={event => editCheck(check.key, { workflowBlobSha: event.target.value })} /></label>
            <Button type="button" onClick={() => setChecks(current => current.filter(item => item.key !== check.key))}>Remove check</Button>
          </fieldset>)}
          <Button type="button" disabled={checks.length >= 10} onClick={() => { const key = nextKey.current++; setChecks(current => [...current, { ...blankCheck, key }]); }}>Add required check</Button>
        </>}
        {review && <label>Reason for changing the policy
          <textarea required={review.failedCheckNames.length > 0 && !enabled} className="k42-task-textarea" maxLength={1000} rows={2} value={reason} onChange={event => setReason(event.target.value)} />
        </label>}
      </fieldset>
      {error && <p role="alert" className="error">{error}</p>}
      <Button type="submit" disabled={busy}>{pending ? 'Retry save' : 'Save settings'}</Button>
    </form>
  </details>;
}
