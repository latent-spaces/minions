import { useEffect, useMemo, useRef, useState } from 'react';
import type { SessionUser } from './session-identity';
import type { HostingArtifact, HostingCandidateSummary, HostingSummary } from '@mlswarm/contracts';
import { hostingApi, isolatedHostingUrl } from './hosting-api';
import { RECONCILE_MS, useRealtimeTick } from './realtime';
import { ProjectOutputs } from './ui/ProjectOutputs';

export function OutputsController({ user, profileId, projectId, owner, closed, active, title }: {
  user: SessionUser; profileId: string; projectId: string; owner: boolean; closed: boolean; active: boolean; title: string;
}) {
  const api = useMemo(() => hostingApi(user, projectId, profileId), [user, projectId, profileId]);
  const [summary, setSummary] = useState<HostingSummary | null>(null), [error, setError] = useState('');
  const [busy, setBusy] = useState(false), [refresh, setRefresh] = useState(0), [cursor, setCursor] = useState<string>();
  const [inspected, setInspected] = useState<{ candidateId: string; artifact: HostingArtifact } | null>(null);
  const actionIds = useRef(new Map<string, string>()), lock = useRef(false), mounted = useRef(true);
  const live = useRealtimeTick(user, projectId, 'hosting', active);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!active) return;
    let alive = true;
    api.read(cursor).then(value => { if (alive) { setSummary(value); setError(''); } }, failure => {
      if (!alive) return;
      setError(failure instanceof Error ? failure.message : 'Outputs could not be loaded.');
      if ([401, 403, 404].includes(failure.status)) setSummary(null);
    });
    return () => { alive = false; };
  }, [api, cursor, active, refresh, live]);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setRefresh(value => value + 1), RECONCILE_MS);
    return () => clearInterval(timer);
  }, [active]);
  useEffect(() => { if (summary && inspected && !summary.candidates.some(candidate => candidate.id === inspected.candidateId)) setInspected(null); }, [summary, inspected]);
  const stableId = (action: string, input: unknown) => {
    const key = JSON.stringify([action, input]);
    let id = actionIds.current.get(key);
    if (!id) { id = crypto.randomUUID(); actionIds.current.set(key, id); }
    return id;
  };
  const action = async (work: () => Promise<unknown>) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try { await work(); }
    catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : 'This action was not confirmed. Retry the same request.');
    }
    finally {
      lock.current = false;
      if (mounted.current) { setBusy(false); setRefresh(value => value + 1); }
    }
  };
  const publish = (candidate: HostingCandidateSummary) => action(() => api.publish(candidate.id, candidate.policyRevision, stableId('publish', candidate.id)));
  return <ProjectOutputs summary={summary} owner={owner} profileId={profileId} closed={closed} title={title}
    inspected={inspected} onInspect={id => void action(async () => { const value = await api.candidate(id); if (mounted.current) setInspected(value); })}
    error={error} busy={busy} url={isolatedHostingUrl(summary?.publishedUrl ?? null, projectId, window.location.origin)}
    onRefresh={() => setRefresh(value => value + 1)} onFirst={() => { setInspected(null); setCursor(undefined); }} onNext={() => { if (summary?.next) { setInspected(null); setCursor(summary.next); } }}
    onPublish={candidate => void publish(candidate)} onUnpublish={() => void action(() => api.unpublish(stableId('unpublish', summary?.policy.revision)))}
    onRetryOperation={() => void action(async () => { if (summary?.operation) await api.retry(summary.operation.id); })} />;
}
