import { useEffect, useId, useRef, useState } from 'react';
import { RUN_LENGTH, validRunMinutes } from '@mlswarm/contracts';
import type { SessionUser } from '../session-identity';
import type { ParticipationControlView, ParticipationControlInput } from '@mlswarm/contracts';
import { ApiError, session, projects } from '../api';
import { Button } from './Button';

type Action = ParticipationControlInput['kind'];
type Request = ParticipationControlInput & { agentId: string };
type Lane = 'grant' | 'end';
const laneFor = (kind: Action): Lane => kind === 'release' || kind === 'cancel_wake' ? 'end' : 'grant';
export const validParticipationMinutes = (minutes: number) => validRunMinutes(minutes);
const validSaved = (value: unknown, lane: Lane): value is Request => {
  if (!value || typeof value !== 'object') return false;
  const v = value as Request;
  return typeof v.agentId === 'string' && /^[\w-]{1,200}$/.test(v.agentId)
    && /^[a-f0-9-]{36}$/i.test(v.id) && /^[a-f0-9-]{36}$/i.test(v.participationId)
    && Number.isSafeInteger(v.generation) && v.generation > 0 && Number.isSafeInteger(v.expectedDeadlineAt) && v.expectedDeadlineAt >= 0
    && ['extend', 'release', 'wake', 'cancel_wake'].includes(v.kind) && laneFor(v.kind) === lane && v.approved === true
    && (v.kind === 'release' || v.kind === 'cancel_wake' ? v.minutes === undefined : validParticipationMinutes(v.minutes!))
    && (v.kind === 'cancel_wake' ? typeof v.wakeId === 'string' && /^[a-f0-9-]{36}$/i.test(v.wakeId) : v.wakeId === undefined);
};

// One controller is shared by the desktop/mobile cards. Ending has its own lane:
// a lost Extend/Wake response must never prevent an explicit End request.
export function useChatParticipationControls(user: SessionUser, projectId: string | null, refresh: (agentId?: string, participation?: ParticipationControlView) => void) {
  const key = `mlswarm-chat-controls:${user.uid}:${projectId}`;
  const [pending, setPending] = useState<Partial<Record<Lane, Request>>>({});
  const [busy, setBusy] = useState<Partial<Record<Lane, boolean>>>({});
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const requests = useRef<Partial<Record<Lane, Request>>>({});
  const locks = useRef<Partial<Record<Lane, boolean>>>({});
  const generation = useRef(0);
  useEffect(() => {
    generation.current++; requests.current = {}; locks.current = {};
    setPending({}); setBusy({}); setError(''); setNotice('');
    for (const lane of ['grant', 'end'] as const) {
      try {
        const raw = sessionStorage.getItem(`${key}:${lane}`), value: unknown = raw ? JSON.parse(raw) : null;
        if (validSaved(value, lane)) requests.current[lane] = value;
      } catch { /* Never send a saved action automatically. */ }
    }
    setPending({ ...requests.current });
    return () => { generation.current++; };
  }, [key]);
  async function execute(request: Request) {
    const lane = laneFor(request.kind);
    if (!projectId || locks.current[lane] || session.currentUid() !== user.uid) return;
    const version = generation.current;
    try { sessionStorage.setItem(`${key}:${lane}`, JSON.stringify(request)); }
    catch { setError('Enable browser storage so an unconfirmed action can be retried safely.'); return; }
    requests.current[lane] = request; locks.current[lane] = true;
    setPending({ ...requests.current }); setBusy(v => ({ ...v, [lane]: true })); setError(''); setNotice('');
    const current = () => version === generation.current && session.currentUid() === user.uid && requests.current[lane]?.id === request.id;
    try {
      const { agentId, ...body } = request;
      const reply = await projects<{ participation: ParticipationControlView; replayed: boolean }>(user,
        `/${projectId}/agents/${encodeURIComponent(agentId)}/participation`, body);
      if (!current()) return;
      sessionStorage.removeItem(`${key}:${lane}`); delete requests.current[lane];
      if (lane === 'end' && requests.current.grant?.agentId === request.agentId && (request.kind === 'cancel_wake' ? requests.current.grant.id === request.wakeId : requests.current.grant.kind === 'extend')) {
        // Server End fences an outstanding grant too. Its eventual response cannot
        // turn a late browser callback into a fresh approval or overwrite this notice.
        sessionStorage.removeItem(`${key}:grant`); delete requests.current.grant;
      }
      setPending({ ...requests.current });
      setNotice(request.kind === 'cancel_wake' ? 'Wake cancelled. No new time was granted.' : request.kind === 'release' ? 'Ended. Your computer will finish up shortly.' : 'Saved. Time starts now; waiting for your computer.');
      refresh(request.agentId, reply.participation);
    } catch (failure) {
      if (!current()) return;
      const refused = failure instanceof ApiError && failure.status >= 400 && failure.status < 500 && ![408, 429].includes(failure.status);
      if (refused) { sessionStorage.removeItem(`${key}:${lane}`); delete requests.current[lane]; setPending({ ...requests.current }); refresh(); }
      setError(`${failure instanceof Error ? failure.message : 'Action not confirmed.'}${refused ? '' : ' Retry the saved action; it will not add time twice.'}`);
    } finally {
      if (version === generation.current) { locks.current[lane] = false; setBusy(v => ({ ...v, [lane]: false })); }
    }
  }
  function act(agentId: string, participation: ParticipationControlView, kind: Action, minutes?: number) {
    const lane = laneFor(kind);
    if (requests.current[lane] || locks.current[lane] || (kind === 'wake' || kind === 'extend') && !validParticipationMinutes(minutes!) || kind === 'cancel_wake' && (participation.pending?.kind !== 'wake' || participation.pending.state !== 'queued')) return;
    return execute({ agentId, id: crypto.randomUUID(), kind, participationId: participation.participationId,
      generation: participation.generation, expectedDeadlineAt: participation.deadlineAt,
      ...(kind === 'cancel_wake' ? { wakeId: participation.pending!.id } : kind === 'release' ? {} : { minutes }), approved: true });
  }
  return { pending, busy, error, notice, act, retry: (lane: Lane) => { const request = requests.current[lane]; if (request) return execute(request); } };
}
export type ChatParticipationControls = ReturnType<typeof useChatParticipationControls>;

export function ChatParticipationRow({ agentId, agentName, participation: p, controls, now, disabled }:
  { agentId: string; agentName: string; participation: ParticipationControlView; controls: ChatParticipationControls; now: number; disabled: boolean }) {
  const id = useId(), [minutesText, setMinutes] = useState('');
  const minutes = Number(minutesText), valid = minutesText !== '' && validParticipationMinutes(minutes);
  const ended = p.deadlineAt <= now || p.state === 'released' || p.state === 'expired';
  const recovery = p.state === 'recovery_required';
  const queued = (p.pending?.state === 'queued' || p.pending?.state === 'accepted') && (p.pending.deadlineAt === null || p.pending.deadlineAt > now);
  const grantExpired = p.pending?.state === 'expired' || p.pending?.state === 'queued' && p.pending.deadlineAt !== null && p.pending.deadlineAt <= now;
  const withinRemainingLimit = ended || !valid || p.deadlineAt - now + minutes * 60000 <= RUN_LENGTH.maxMinutes * 60000;
  const hasGrant = controls.pending.grant?.agentId === agentId;
  const hasEnd = controls.pending.end?.agentId === agentId;
  const canEnd = !ended || recovery;
  const grantBlocked = disabled || !!controls.pending.grant || !!controls.pending.end || !!controls.busy.grant || queued || recovery;
  const state = recovery ? 'Needs a fix on your computer' : queued && p.pending?.state === 'accepted' ? 'Waking on your computer' : queued && p.pending?.kind !== 'release' ? 'Saved · waiting for your computer'
    : p.state === 'released' ? 'Ended' : p.deadlineAt <= now || p.state === 'expired' ? 'Time ended'
    : p.state === 'approved' ? 'Saved · waiting for your computer' : 'Ready when you continue the chat';
  return <li className="chat-participation-row">
    <div className="my-worker-identity"><strong dir="auto">{agentName}</strong><span className="muted">Works with you in this chat · {state}</span>
      <span>Works until <time dateTime={new Date(p.deadlineAt).toISOString()}>{new Date(p.deadlineAt).toLocaleString()}</time></span>
      {queued && p.pending?.deadlineAt != null && p.pending.deadlineAt !== p.deadlineAt && <small>Requested until <time dateTime={new Date(p.pending.deadlineAt).toISOString()}>{new Date(p.pending.deadlineAt).toLocaleString()}</time></small>}
      {grantExpired && <small role="status">The requested time ran out. Wake it to keep going.</small>}
      {p.pending?.state === 'failed' && <small role="status">{p.pending.message ?? 'Your computer could not apply this. Check it in your coding agent.'}</small>}
      {queued && p.pending?.kind === 'release' && <small role="status">Ended · your computer is finishing up</small>}
      {queued && p.pending?.kind === 'wake' && <small role="status">{p.pending.state === 'accepted' ? 'Waking on your computer. You can End it once it’s awake.' : 'Wake saved. You can cancel it until your computer picks it up.'}</small>}
      {p.pending?.state === 'cancelled' && <small role="status">Wake cancelled. No new time was granted.</small>}
    </div>
    <div className="chat-participation-actions">
      {!recovery && <div className="chat-participation-grant"><label htmlFor={id}>{ended ? 'Wake for' : 'Add time'}</label>
        <div><input id={id} type="number" inputMode="numeric" min={RUN_LENGTH.minMinutes} max={RUN_LENGTH.maxMinutes} step={RUN_LENGTH.stepMinutes} placeholder="Minutes" value={minutesText}
          aria-label={`${ended ? 'How long to wake' : 'Time to add'} for ${agentName}, in minutes`} aria-describedby={`${id}-help`}
          disabled={grantBlocked} onChange={e => setMinutes(e.target.value)} />
          <Button type="button" className="soft" disabled={grantBlocked || !valid || !withinRemainingLimit}
            title={!withinRemainingLimit ? 'Keep total remaining time within 24 hours' : undefined}
            aria-label={ended ? `Wake ${agentName}` : `Add time to ${agentName} in this chat`} onClick={() => void controls.act(agentId, p, ended ? 'wake' : 'extend', minutes)}>{ended ? 'Wake' : 'Add time'}</Button>
        </div><small id={`${id}-help`}>5 minutes to 24 hours, in steps of 5 minutes</small>
      </div>}
      {queued && p.pending?.kind === 'wake' && p.pending.state === 'queued' && <Button type="button" className="soft"
        disabled={disabled || !!controls.busy.end || !!controls.pending.end} aria-label={`Cancel queued Wake for ${agentName}`}
        onClick={() => void controls.act(agentId, p, 'cancel_wake')}>Cancel Wake</Button>}
      {canEnd && <Button type="button" className="soft" disabled={disabled || !!controls.busy.end || !!controls.pending.end}
        aria-label={`End ${agentName} in this chat`} onClick={() => void controls.act(agentId, p, 'release')}>End</Button>}
      {hasGrant && <Button type="button" className="soft" disabled={disabled || !!controls.busy.grant || !!controls.pending.end}
        onClick={() => void controls.retry('grant')}>{controls.busy.grant ? 'Saving…' : `Retry ${controls.pending.grant!.kind === 'wake' ? 'Wake' : 'adding time'}`}</Button>}
      {hasEnd && <Button type="button" className="soft" disabled={disabled || !!controls.busy.end}
        onClick={() => void controls.retry('end')}>{controls.busy.end ? 'Saving…' : controls.pending.end?.kind === 'cancel_wake' ? 'Retry Cancel Wake' : 'Retry End'}</Button>}
    </div>
  </li>;
}
