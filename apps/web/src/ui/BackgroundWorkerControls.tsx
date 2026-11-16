import { useEffect, useRef, useState } from 'react';
import type { SessionUser } from '../session-identity';
import type { BackgroundControlInput, BackgroundControlReply, BackgroundControlView } from '@minions/contracts';
import { ApiError, session, projects } from '../api';
import { Button } from './Button';
import { backgroundCommandState, type BackgroundCommandState } from './background-command-state';
import { controlLabel } from './agent-running-state';

// Independent per-agent lanes: an uncertain reply must not prevent control of
// another worker. Saved requests are retried only by an explicit click.
export function useBackgroundWorkerControls(user: SessionUser, projectId: string | null, refresh: () => void) {
  const [state, setState] = useState<BackgroundCommandState>({ pending: {}, busy: {}, errors: {} });
  const controller = useRef<ReturnType<typeof backgroundCommandState> | null>(null);
  const refreshRef = useRef(refresh); refreshRef.current = refresh;
  useEffect(() => {
    setState({ pending: {}, busy: {}, errors: {} });
    if (!projectId) return;
    const current = backgroundCommandState({
      key: `minions-background-controls:${user.uid}:${projectId}`, projectId, storage: sessionStorage,
      authorized: () => session.currentUid() === user.uid, requestId: () => crypto.randomUUID(),
      send: (agentId, body) => projects<BackgroundControlReply>(user, `/${projectId}/agents/${encodeURIComponent(agentId)}/background-control`, body),
      refused: failure => failure instanceof ApiError && failure.status >= 400 && failure.status < 500 && ![408, 429].includes(failure.status),
      refresh: () => refreshRef.current(), changed: setState,
    });
    controller.current = current; setState(current.snapshot());
    return () => { current.dispose(); if (controller.current === current) controller.current = null; };
  }, [user, projectId]);
  return { ...state,
    act: (agentId: string, view: BackgroundControlView, kind: BackgroundControlInput['kind']) => controller.current?.act(agentId, view, kind),
    retry: (agentId: string) => controller.current?.retry(agentId),
  };
}
export type BackgroundWorkerControls = ReturnType<typeof useBackgroundWorkerControls>;

// Between turns the agent is idle: it wakes when a new message or a steer arrives (owner feedback, 20 October 2026).

// Kept with the pure status code so it is tested without a browser.
export { CONTROL_LABEL, controlLabel, backgroundControlStatus } from './agent-running-state';

export function BackgroundWorkerActions({ agentId, agentName, view, controls, now, disabled }:
  { agentId: string; agentName: string; view: BackgroundControlView | null | undefined; controls: BackgroundWorkerControls; now: number; disabled: boolean }) {
  const pending = controls.pending[agentId], busy = !!controls.busy[agentId];
  const awaitingDevice = view?.pending?.state === 'queued' || view?.pending?.state === 'accepted';
  const ended = !view || ['stopped', 'stopping', 'failed', 'recovery_required'].includes(view.state);
  const paused = view?.state === 'paused';
  const stale = !view || now - view.deviceLastSeenAt >= 90000;
  const canPause = view && !ended && ['accepted', 'starting', 'running', 'waiting'].includes(view.state);
  const canResume = view && !ended && paused && !!view.pauseOperationId;
  const [confirmKill, setConfirmKill] = useState(false);
  useEffect(() => { if (ended || awaitingDevice) setConfirmKill(false); }, [ended, awaitingDevice]);
  // Opening the confirmation focuses Keep, the safe choice; Keep returns focus to Kill.
  const killRef = useRef<HTMLButtonElement>(null), keepRef = useRef<HTMLButtonElement>(null), returnFocus = useRef(false);
  useEffect(() => {
    if (confirmKill) keepRef.current?.focus();
    else if (returnFocus.current) { returnFocus.current = false; killRef.current?.focus(); }
  }, [confirmKill]);
  return <>
    {(canPause || canResume) && <Button type="button" className="soft"
      disabled={disabled || busy || !!pending || awaitingDevice || !view.available || stale}
      title={stale ? 'Your computer needs to be online with Minions running' : !view.available ? 'Not available for this agent right now' : paused ? 'Resume' : 'Pause'}
      aria-label={`${paused ? 'Resume' : 'Pause'} ${agentName}`}
      onClick={() => void controls.act(agentId, view, paused ? 'resume' : 'pause')}>{paused ? 'Resume' : 'Pause'}</Button>}
    {view && !ended && !confirmKill && <Button ref={killRef} type="button" className="soft"
      disabled={disabled || busy || !!pending || view.pending?.kind === 'stop' && awaitingDevice || !view.available || stale}
      title="Ends this agent at once, mid-turn. It cannot be undone." aria-label={`Kill ${agentName}`}
      onClick={() => setConfirmKill(true)}>Kill</Button>}
    {view && !ended && confirmKill && <span className="background-worker-confirm" role="group" aria-label={`Confirm kill of ${agentName}`}>
      <span>Kill this agent? It cannot be undone.</span>
      <Button type="button" className="soft" disabled={disabled || busy}
        onClick={() => { returnFocus.current = true; setConfirmKill(false); void controls.act(agentId, view, 'stop'); }}>Kill now</Button>
      <Button ref={keepRef} type="button" className="soft" onClick={() => { returnFocus.current = true; setConfirmKill(false); }}>Keep</Button>
    </span>}
    {pending && <Button type="button" className="soft" disabled={disabled || busy}
      aria-label={`Retry saved ${controlLabel(pending.kind)} for ${agentName}`}
      onClick={() => void controls.retry(agentId)}>{busy ? 'Saving…' : `Retry ${controlLabel(pending.kind)}`}</Button>}
  </>;
}
