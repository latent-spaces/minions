import type { SessionUser } from './session-identity';
import { lazy, Suspense, useContext } from 'react';
import { ProjectScope, type AgentRow } from './api';
import { usePages } from './shared';
import type { Route } from './route';
const ProjectCommunication = lazy(() => import('./ui/ProjectCommunication').then(m => ({default:m.ProjectCommunication})));

const agentsPath = () => '/agents';
// The Updates tab's live map, above the updates feed. Project usage sits in the header's repository bar.
// A caller that already polls the agents passes them in.
export function ProjectActivity({ liveUrl = null, user, tick, projectName, canAddAgent = false, active, go, readOnly, pauseRequest, agentRows, onOpenAgent, onCopyLink }: { pauseRequest?: { revision: number; requestedAt: number }; onOpenAgent?: (id: string) => void; onCopyLink?: (() => void) | null; liveUrl?: string | null; agentRows?: AgentRow[]; readOnly: boolean; projectName: string; canAddAgent?: boolean; user: SessionUser; tick: number; active: boolean; go: (route: Route) => void }) {
  const projectId = useContext(ProjectScope);
  const agents = usePages<AgentRow>(user, agentsPath, tick, active && !agentRows);
  return <div className="k42-activity-main">
    <div className="k42-activity-part"><Suspense fallback={<p className="muted">Loading communication…</p>}><ProjectCommunication key={`${user.uid}:${projectId}`} liveUrl={liveUrl} user={user} projectId={projectId} active={active} closed={readOnly} pauseRequest={pauseRequest} projectName={canAddAgent && !readOnly ? projectName : undefined} onOpenAgent={onOpenAgent} onCopyLink={onCopyLink} agents={agentRows ?? agents.page?.items ?? []} go={go}/></Suspense></div>
  </div>;
}
