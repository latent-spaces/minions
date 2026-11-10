import { useCallback, useEffect, useState } from 'react';
import type { SessionUser } from './session-identity';
import type { ProjectMergingAccess } from '@mlswarm/contracts';
import { projects } from './api';
import type { Workspace } from './project-api';
import { CardSettings } from './CardSettings';
import { MERGE_APPROVAL_TEXT } from './merge-approval';
import { canManageMerging } from './merging-access';
import { useProjectMergeAccess } from './merge-access';
import { MergeAccessControl, MergeAccessFeedback } from './ui/MergeAccessControl';
import { MergingAccess } from './ui/MergingAccess';
import { Button } from './ui/Button';
import './ui/merging.css';

export function ProjectMerging({ user, workspace, refresh, active, refreshKey }: {
  user: SessionUser; workspace: Workspace; refresh: () => void; active: boolean; refreshKey: number;
}) {
  const access = useProjectMergeAccess({ user, projectId: workspace.id, role: workspace.role, closed: workspace.execution === 'closed', active, refreshKey });
  const allowed = canManageMerging(workspace.role);
  const [data, setData] = useState<ProjectMergingAccess | null>(null);
  const [error, setError] = useState<string | null>(null), [loading, setLoading] = useState(true), [retry, setRetry] = useState(0);
  const [peopleCursors, setPeopleCursors] = useState<(string | null)[]>([null]);
  const [agentCursors, setAgentCursors] = useState<(string | null)[]>([null]);
  const peopleCursor = peopleCursors.at(-1), agentsCursor = agentCursors.at(-1);
  const request = useCallback(<T,>(path: string, body?: object) => projects<T>(user, path, body), [user]);
  useEffect(() => {
    if (!active || !allowed) { setData(null); return; }
    let cancelled = false;
    const query = new URLSearchParams();
    if (peopleCursor) query.set('peopleCursor', peopleCursor);
    if (agentsCursor) query.set('agentsCursor', agentsCursor);
    setLoading(true); setError(null);
    request<ProjectMergingAccess>(`/${workspace.id}/merging?${query}`).then(value => {
      if (!cancelled) { setData(value); setLoading(false); }
    }, e => { if (!cancelled) { setData(null); setLoading(false); setError(e instanceof Error ? e.message : 'Could not load merging access.'); } });
    return () => { cancelled = true; };
  }, [active, allowed, request, workspace.id, peopleCursor, agentsCursor, refreshKey, retry]);
  if (!allowed) return <p role="status">Merge rules are available only to the project owner.</p>;
  return <section className="k42-merging" aria-labelledby="merging-title">
    <h3 id="merging-title" className="visually-hidden">Merge rules</h3>
    <section className="k42-merging-panel" aria-label="Current merge rules">
      {workspace.execution === 'closed' && <p className="muted">Project closed. Reopen it to change the merge rules.</p>}
      <CardSettings mode="merging" request={request} workspace={workspace} definition={workspace.definition} refresh={refresh} active={active} />
      <p className="k42-merging-worker-status">{MERGE_APPROVAL_TEXT[workspace.definition.mergeApproval].worker}</p>
      <details className="k42-merging-disclosure"><summary>How merge rules work</summary>
        <p>The owner can edit here or through project tools. Workers load changes before their next turn.</p>
        <p>Review instructions guide agents. Selected-people merge access is enforced separately through GitHub rules.</p>
        <p>Review requirements are agent guidance. Direct pushes, publishing and deployment need explicit human approval.</p>
      </details>
    </section>
    <MergeAccessFeedback access={access} />
    {access.value && <MergeAccessControl value={access.value} busy={access.locked} closed={workspace.execution === 'closed'} refresh={access.refresh} save={access.save} />}
    {access.loading && !access.value && <p role="status">Loading merge access…</p>}
    {loading && <p role="status">Loading access information…</p>}
    {error && <div role="alert"><p className="error">{error}</p><Button className="soft" onClick={() => setRetry(value => value + 1)}>Try again</Button></div>}
    {data?.projectId === workspace.id && !loading && <MergingAccess data={data} mergeAccess={access.value} changeMergeAccess={access.toggle} mergeAccessBusy={access.locked} closed={workspace.execution === 'closed'} peopleFirst={peopleCursors.length === 1} agentsFirst={agentCursors.length === 1}
      previousPeople={() => setPeopleCursors(value => value.slice(0, -1))} nextPeople={() => data.peopleNext && setPeopleCursors(value => [...value, data.peopleNext])}
      previousAgents={() => setAgentCursors(value => value.slice(0, -1))} nextAgents={() => data.agentsNext && setAgentCursors(value => [...value, data.agentsNext])} />}
  </section>;
}
