import { useCallback, useRef, useState } from 'react';
import type { SessionUser } from '../session-identity';
import type { HumanRequest } from '@mlswarm/contracts';
import { popupRequestRows } from './agent-request-popup';
import { session } from '../api';
import { mayLeaveProject, projectRoute, type Route } from '../route';
import { NavLink } from '../shared';
import { ParticipantPopup } from './ParticipantPopup';
import { RequestItem } from './NeedsYou';
import { useInvitedProfile } from './use-invited-profile';
import { Button } from './Button';
import { useMyWorkers } from './MyWorkerControls';

export function AgentRequestsPopup({ user, projectId, agentId, name, requests, readOnly, go, onClose, loading, loadError, retry }: {
  user: SessionUser; projectId: string; agentId: string; name: string; loading: boolean; loadError: string | null; retry: () => void; requests: HumanRequest[]; readOnly: boolean; go: (route: Route) => void; onClose: () => void;
}) {
  const { profileId, error, deny } = useInvitedProfile(user), workers = useMyWorkers() ?? undefined;
  const [answered, setAnswered] = useState<Record<string, HumanRequest>>({});
  const latest = useRef(new Map<string, HumanRequest>());
  for (const request of requests) latest.current.set(request.id, request);
  const [protectedIds, setProtectedIds] = useState(new Set<string>());
  const protectAnswer = useCallback((id: string, protectedAnswer: boolean) => setProtectedIds(current => {
    if (current.has(id) === protectedAnswer) return current;
    const next = new Set(current); if (protectedAnswer) next.add(id); else next.delete(id); return next;
  }), []);
  const shown = popupRequestRows(requests, Object.values(answered), [...protectedIds].flatMap(id => latest.current.get(id) ?? []));
  const navigate = (route: Route) => { if (mayLeaveProject()) { onClose(); go(route); } };
  if (session.currentUid() !== user.uid) return null;
  return <ParticipantPopup title={`${name} · Needs you`} onClose={onClose}>
    <p><NavLink to={projectRoute(projectId, 'agents', agentId, null, 'all')} go={navigate}>Open agent</NavLink></p>
    {loadError && <div role="alert"><p>Could not refresh requests: {loadError}</p><Button onClick={retry}>Try again</Button></div>}
    {loading && !loadError && <p role="status">Loading requests…</p>}
    {error && <p role="alert">{error}</p>}
    {!profileId && !error && <p role="status">Checking access…</p>}
    {profileId && !(loading && loadError) && <div className="k42-needs-you k42-needs-list">{shown.map(request => <RequestItem key={request.id} request={request} user={user} profileId={profileId} go={navigate} workers={workers} readOnly={readOnly} onProtectedChange={protectAnswer}
      onAnswered={next => setAnswered(current => ({ ...current, [next.id]: next }))} onDenied={failure => deny(failure as Error)} />)}</div>}
    {profileId && !loading && !loadError && shown.length === 0 && <p>No outstanding requests.</p>}
  </ParticipantPopup>;
}
