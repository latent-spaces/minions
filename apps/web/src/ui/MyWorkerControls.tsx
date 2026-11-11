import { AgentStatusIcon } from './AgentStatusIcon';
import { createContext, Fragment, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { SessionUser } from '../session-identity';
import type { ProjectWorkersView } from '@mlswarm/contracts';
import { ApiError, session as signedIn, projects } from '../api';
import { Button } from './Button';
import { formatRoute, projectRoute } from '../route';
import { ChatParticipationRow, useChatParticipationControls } from './ChatParticipationControls';
import { BackgroundWorkerActions, backgroundControlStatus, controlLabel, IDLE_HINT, useBackgroundWorkerControls } from './BackgroundWorkerControls';
import { atTokenCap, PAST_END, providerLimitText, TIME_AND_TOKEN_CAP, TOKEN_CAP, tokenUsageNote, workerAgentStatus } from './agent-running-state';
import { backgroundIconState } from './agent-status-icon';
import { refreshOnReturn } from '../refresh-on-return';

// The person's own agents in the open project, queued ones included: the one source every project screen reads.
// The project page loads it once (App) and provides it here; nothing else fetches its own copy.
export type MyWorkers = ReturnType<typeof useMyWorkerControls>;
export const MyWorkersContext = createContext<MyWorkers | null>(null);
export const useMyWorkers = () => useContext(MyWorkersContext);
export function useMyWorkerControls(user: SessionUser, projectId: string | null, active: boolean, pollMs = 15000) {
  const [data, setData] = useState<ProjectWorkersView | null>(null), [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [clock, setClock] = useState(Date.now()), [refresh, setRefresh] = useState(0);
  const offset = useRef(0);
  const background = useBackgroundWorkerControls(user, projectId, () => setRefresh(v => v + 1));
  const participation = useChatParticipationControls(user, projectId, (agentId, value) => {
    if (agentId && value) setData(current => current ? { ...current, agents: current.agents.map(row => row.agentId === agentId ? { ...row, participation: value } : row) } : current);
    setRefresh(v => v + 1);
  });
  useEffect(() => { setData(null); setError(''); }, [user.uid, projectId]);
  useEffect(() => {
    if (!projectId || !active) return;
    let cancelled = false, loading = false;
    const load = async () => {
      if (loading) return; loading = true; setLoading(true);
      try {
        const reply = await projects<ProjectWorkersView>(user, `/${projectId}/my-workers`);
        if (!cancelled && signedIn.currentUid() === user.uid) { offset.current = reply.serverTime - Date.now(); setData(reply); setError(''); }
      } catch (failure) { if (!cancelled) { setError(failure instanceof Error ? failure.message : 'Could not load your agents.'); if (!(failure instanceof ApiError && failure.status === 429)) setData(null); } }
      finally { loading = false; if (!cancelled) setLoading(false); }
    };
    void load(); const poll = setInterval(() => void load(), pollMs), timer = setInterval(() => setClock(Date.now()), 1000);
    const stop = refreshOnReturn(() => void load());
    return () => { cancelled = true; clearInterval(poll); clearInterval(timer); stop(); };
  }, [user, projectId, active, refresh, pollMs]);
  return { data, error, loading, participation, background, now: clock + offset.current, refresh: () => setRefresh(v => v + 1) };
}
// jobBar: the owner's job bar (end time and token cap), shown above the agents.
export function MyWorkerControls({ projectId, controls, disabled: requested, inline = false, jobBar = null }: { inline?: boolean; projectId: string; controls: ReturnType<typeof useMyWorkerControls>; disabled: boolean; jobBar?: ReactNode }) {
  const { data, now } = controls;
  // A closed project allows no agent controls.
  const disabled = requested || !!data?.projectClosed;
  const Container = inline ? 'section' : 'details';
  const Heading = inline ? 'h4' : 'summary';
  // Pause all / Kill all act on each of the person's controllable agents in turn (owner decision, 9 November 2026).
  const [confirmKillAll, setConfirmKillAll] = useState(false);
  // Opening the confirmation focuses Keep, the safe choice; Keep returns focus to Kill all.
  const killAllRef = useRef<HTMLButtonElement>(null), keepAllRef = useRef<HTMLButtonElement>(null), returnFocus = useRef(false);
  useEffect(() => {
    if (confirmKillAll) keepAllRef.current?.focus();
    else if (returnFocus.current) { returnFocus.current = false; killAllRef.current?.focus(); }
  }, [confirmKillAll]);
  const awaiting = (v: { pending?: { state: string; kind: string } | null }, kind?: string) => !!v.pending && ['queued', 'accepted'].includes(v.pending.state) && (!kind || v.pending.kind === kind);
  // A pending Pause or Resume stays accepted until the turn ends; Kill replaces it, as the agent's own Kill does.
  const killable = (data?.agents ?? []).map(a => a.backgroundControl).filter((v): v is NonNullable<typeof v> =>
    !!v && v.target.projectId === projectId && v.available && now - v.deviceLastSeenAt < 90000 && !['stopped', 'stopping', 'failed', 'recovery_required'].includes(v.state)
    && !awaiting(v, 'stop') && !controls.background.pending[v.target.agentId] && !controls.background.busy[v.target.agentId]);
  const pausable = killable.filter(v => !awaiting(v) && ['accepted', 'starting', 'running', 'waiting'].includes(v.state));
  // A changed list drops an open confirmation, so an old count is never confirmed.
  const killKey = killable.map(v => v.target.agentId).join(' ');
  useEffect(() => setConfirmKillAll(false), [killKey]);
  const actOnAll = (views: typeof killable, kind: 'pause' | 'stop') => { for (const v of views) void controls.background.act(v.target.agentId, v, kind); };
  return <Container className="my-worker-controls">
    <Heading>My agents{data ? ` · ${data.agents.length}` : ''}</Heading>
    {jobBar}
    {killable.length > 1 && <p className="my-worker-all">
      {pausable.length > 1 && <Button type="button" className="soft" disabled={disabled} title="Each agent finishes its turn, then waits" onClick={() => actOnAll(pausable, 'pause')}>Pause all</Button>}{' '}
      {!confirmKillAll && <Button ref={killAllRef} type="button" className="soft" disabled={disabled} title="Ends every one of your agents here at once. It cannot be undone." onClick={() => setConfirmKillAll(true)}>Kill all</Button>}
      {confirmKillAll && <span role="group" aria-label="Confirm kill of all your agents">Kill all {killable.length} agents? It cannot be undone. <Button type="button" className="soft" disabled={disabled} onClick={() => { setConfirmKillAll(false); actOnAll(killable, 'stop'); }}>Kill all now</Button>{' '}<Button ref={keepAllRef} type="button" className="soft" onClick={() => { returnFocus.current = true; setConfirmKillAll(false); }}>Keep</Button></span>}
    </p>}
    {data?.agents.some(a => a.participation) && <p className="muted">Chat agents work only while the chat is open.</p>}
    {controls.participation?.error && <p className="error" role="alert">{controls.participation.error}</p>}
    {controls.participation?.notice && <p role="status">{controls.participation.notice}</p>}
    {controls.error && <p className="error" role="alert">{controls.error} <Button className="soft" onClick={controls.refresh}>Refresh</Button></p>}
    {Object.values(controls.background?.pending ?? {}).filter(request => !data?.agents.some(a => a.agentId === request.agentId)).map(request =>
      <div key={request.agentId}>
        {controls.background.errors[request.agentId] && <p className="error" role="alert">{controls.background.errors[request.agentId]}</p>}
        <Button type="button" className="soft" disabled={disabled || !!controls.background.busy[request.agentId]}
          onClick={() => void controls.background.retry(request.agentId)}>Retry saved {controlLabel(request.kind)}</Button>
      </div>)}
    {(['grant', 'end'] as const).map(lane => {
      const request = controls.participation?.pending[lane];
      return request && !data?.agents.some(a => a.agentId === request.agentId && a.participation)
        ? <Button key={lane} type="button" className="soft" disabled={disabled || !!controls.participation.busy[lane]}
          onClick={() => void controls.participation.retry(lane)}>Retry saved {request.kind === 'cancel_wake' ? 'Cancel Wake' : request.kind === 'release' ? 'End' : request.kind === 'wake' ? 'Wake' : 'adding time'}</Button> : null;
    })}
    {!data && !controls.error && <p role="status">Loading your agents…</p>}
    {data?.agents.length === 0 && <p className="muted">You have no agents in this project yet.</p>}
    <ul className="my-worker-list">{data?.agents.map(a => {
      const chat = a.participation && controls.participation ? <ChatParticipationRow agentId={a.agentId} agentName={a.agentName} participation={a.participation} controls={controls.participation} now={now} disabled={disabled} /> : null;
      if (chat && !a.worker.session && !a.backgroundControl && !controls.background?.pending[a.agentId]) return <Fragment key={a.agentId}>{chat}</Fragment>;
      const background = a.backgroundControl?.target.agentId === a.agentId && a.backgroundControl.target.projectId === projectId ? a.backgroundControl : null;
      // Runtime identity is independent of the older steering projection. Never
      // use a historical steering run to extend a different current mission.
      const s = background && a.worker.session?.missionId !== background.missionId ? null : a.worker.session;
      const hasSession = !!background || !!s, remaining = Math.max(0, (background?.deadlineAt ?? s?.deadlineAt ?? now) - now);
      const ended = background ? ['stopped', 'failed'].includes(background.state) : !!s && ['stopped','completed'].includes(s.phase);
      const fresh = a.worker.available && !!s && now - s.lastContactAt < 90000;
      const minutes = Math.ceil(remaining / 60000), time = minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes} min`;
      const starting = !!a.run && ['pending','accepted','starting'].includes(a.run.state);
      const status = a.projectPause || starting ? workerAgentStatus(a,now).label : background ? backgroundControlStatus(background, now, s) : !s ? 'Not running' : ended ? s.phase === 'completed' ? 'Finished' : 'Stopped' : !fresh ? 'Offline' : remaining === 0 ? s.phase === 'working' ? PAST_END.finishing : PAST_END.waiting : ({working:'Working',waiting:'Idle',paused:'Paused',blocked:'Blocked',stopped:'Stopped',completed:'Finished'}[s.phase] ?? s.phase);
      const limit = status === 'Idle' && s?.phase === 'waiting' ? providerLimitText(s) : null;
      const state = !atTokenCap(s) ? limit ?? status : status === 'Idle' ? TOKEN_CAP : status === PAST_END.waiting ? TIME_AND_TOKEN_CAP : status, tokens = !ended ? tokenUsageNote(s) : null;
      return <Fragment key={a.agentId}>{chat}<li className="background-worker-row"><div className="my-worker-identity"><strong>{a.agentName}</strong><span className="muted" title={state === 'Idle' ? IDLE_HINT : undefined}>{chat ? 'Works on its own · ' : ''}<span className="k42-agent-status-text"><AgentStatusIcon label={state} state={limit ? 'waiting' : background && !a.projectPause && !starting && state !== TOKEN_CAP ? backgroundIconState(background, now, s) : undefined} decorative />{state}</span>{!ended && hasSession && remaining > 0 ? ` · ${time} left` : ''}</span>
        {tokens && <small>{tokens}{state === TOKEN_CAP ? ' Raise the cap to continue.' : ''}</small>}
        {/* Only a connector without background controls publishes no control view; a control view that is unavailable has another cause. */}
        {!ended && !background && !!s && <small>Update MyLittleSwarm on your computer to pause or resume.</small>}
        {background && !ended && !background.available && a.lastRun?.endReason === 'computer_revoked' && <small>This computer’s approval ended. Approve it again to control this agent.</small>}
        {background && !ended && now - background.deviceLastSeenAt >= 90000 && <small>Your computer is offline. Saved actions run when it is back.</small>}
        {background?.pending?.state === 'applied' && !ended && !(background.pending.kind === 'pause' && background.state === 'paused') && <small role="status">{background.pending.kind === 'stop' ? 'Killed' : background.pending.kind === 'pause' ? 'Paused' : 'Resumed'}.</small>}
        {background?.pending && ['failed', 'expired'].includes(background.pending.state) && <small role="status">{controlLabel(background.pending.kind)} {background.pending.state}. {background.pending.message ?? 'Check the agent before trying again.'}</small>}
        {controls.background?.errors[a.agentId] && <small className="error" role="alert">{controls.background.errors[a.agentId]}</small>}
      </div><div className="background-worker-actions">
        {controls.background && <BackgroundWorkerActions agentId={a.agentId} agentName={a.agentName} view={background} controls={controls.background} now={now} disabled={disabled} />}
        {!starting && (!hasSession || ended) && <a className="my-worker-setup" href={`/viewer/${formatRoute(projectRoute(projectId, 'agents'))}`} title="Start it again from your coding agent">{ended ? 'Start again…' : 'Set up…'}</a>}
      </div></li></Fragment>;
    })}</ul>
  </Container>;
}
