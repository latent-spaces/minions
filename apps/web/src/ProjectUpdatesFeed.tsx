import type { SessionUser } from './session-identity';
import { useCallback } from 'react';
import type { ProgressScreenshot } from '@minions/contracts';
import type { Route } from './route';
import { ProjectUpdates } from './ui/ProjectProgress';
import { useProjectProgress } from './useProjectProgress';
import { readProjectScreenshot } from './progress-api';

// The project's Updates panel, beside every tab: what its agents posted, newest first (owner, 11 November 2026).
export function ProjectUpdatesFeed({ projectId, user, tick, active, go, onPendingChange }: {
  projectId: string; user: SessionUser; tick: number; active: boolean; go: (route: Route) => void;
  onPendingChange?: (count: number) => void;
}) {
  const updates = useProjectProgress(projectId, user, tick, active);
  const resolveScreenshot = useCallback((image: ProgressScreenshot) => readProjectScreenshot(projectId, user, image), [projectId, user]);
  return <ProjectUpdates projectId={projectId} {...updates} active={active} resolveScreenshot={resolveScreenshot} go={go} onPendingChange={onPendingChange} />;
}
