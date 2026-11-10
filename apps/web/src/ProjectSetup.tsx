import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionUser } from './session-identity';
import type { ProjectSetupPlan } from '@mlswarm/contracts';
import { ApiError, session, platform } from './api';
import { usePrivateProjectRequest } from './PrivateProjects';
import { hold, mayLeaveProject, projectRoute, type Route } from './route';
import { repositoryUrl } from './proposal-form';
import { ProjectSetupModal, type PrivateLimits } from './ui/project-setup/ProjectSetupModal';
import type { ProjectSetupDraft } from './ui/project-setup/types';
import { notify } from './ui/Toast';

type Intent = { body: object };

/** Exact retry bodies are retained until the service confirms their outcome. */
export function ProjectSetup({ user, go, refresh }: { user: SessionUser; go: (route: Route) => void; refresh: () => void }) {
  const account = usePrivateProjectRequest(user);
  const [busy, setBusy] = useState(false), [pending, setPending] = useState<Intent | null>(null);
  const [error, setError] = useState<string | null>(null), [status, setStatus] = useState('');
  const [privateLimits, setPrivateLimits] = useState<PrivateLimits | null>(null);
  const [dirty, setDirty] = useState(false);
  const lock = useRef(false), alive = useRef(true), release = useRef<(() => void) | null>(null);
  const current = () => alive.current && session.currentUid() === user.uid;
  const onDirtyChange = useCallback((value: boolean) => setDirty(value), []);
  useEffect(() => { alive.current = true; return () => { alive.current = false; release.current?.(); }; }, []);
  useEffect(() => {
    if (dirty || pending || busy) release.current ??= hold();
    else { release.current?.(); release.current = null; }
  }, [dirty, pending, busy]);
  useEffect(() => {
    let active = true;
    platform<{ maxPrivateParticipants: number; maxAgentsPerParticipant: number }>(user, '/limits').then(value => {
      if (!active) return;
      setPrivateLimits({ people: value.maxPrivateParticipants, agentsPerPerson: value.maxAgentsPerParticipant });
    }, () => {});
    return () => { active = false; };
  }, [user]);
  function close() {
    if (busy || !mayLeaveProject()) return;
    release.current?.(); release.current = null;
    go({ view: 'projects' });
  }
  async function execute(intent: Intent) {
    if (lock.current || !account.ready || !current()) return;
    lock.current = true; setBusy(true); setPending(intent); setError(null);
    try {
      setStatus('Creating your private project…');
      const created = await account.request<{ id: string }>('/private', intent.body);
      if (!current()) return;
      release.current?.(); release.current = null;
      setPending(null); setDirty(false); notify('Private project created.'); refresh(); go(projectRoute(created.id));
    } catch (failure) {
      if (!current()) return;
      setError(failure instanceof Error ? failure.message : 'Could not confirm the result. Retry the same request.');
      const definite = failure instanceof ApiError && failure.status >= 400 && failure.status < 500 && ![408, 429].includes(failure.status);
      if (definite) setPending(null);
    } finally { lock.current = false; if (current()) { setBusy(false); setStatus(''); } }
  }
  function confirm(draft: ProjectSetupDraft) {
    if (pending) { void execute(pending); return; }
    const plan: ProjectSetupPlan = { peopleNote: draft.peopleNote.trim(),
      communication: { defaults: { broadcastAllowed: true, sendsPerHour: draft.sendsPerHour,
        minimumGapSeconds: draft.minimumGapSeconds, broadcastsPerHour: draft.broadcastsPerHour }, sharedBroadcastsPerHour: draft.sharedBroadcastsPerHour } };
    void execute({ body: { client_request_id: crypto.randomUUID(), title: draft.name.trim(), goal: draft.purpose.trim(), setupPlan: plan,
      agentGuidance: draft.agentGuidance.trim(), ...(repositoryUrl(draft.repository) ? { githubUrl: repositoryUrl(draft.repository)! } : {}) } });
  }
  return <>
    <ProjectSetupModal open mode="private" visibilityChosen onClose={close} onDirtyChange={onDirtyChange}
      locked={busy || !!pending} busy={busy} retrying={!!pending} errorMessage={error ?? account.error}
      status={status || (!account.ready ? 'Checking your MyLittleSwarm account…' : '')} privateLimits={privateLimits}
      onRetryAccount={account.error && !account.checking ? account.retry : undefined}
      submitDisabled={!account.ready} onConfirm={confirm} />
  </>;
}
