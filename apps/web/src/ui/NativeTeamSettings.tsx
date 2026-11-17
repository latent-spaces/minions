import { useCallback, useMemo } from 'react';
import type { NativeTeamSettings as Settings } from '@minions/contracts';
import type { SessionUser } from '../session-identity';
import { session } from '../api';
import { authorizedRequest } from '../authorized-request';
import { ownProfileId as lookupOwnProfileId } from './use-invited-profile';
import { TaskSettingsControl } from './TaskSettingsControl';
import './project-tasks.css';

/** Project teams on/off (owner only; off by default). Turning teams off keeps every team, membership and history and
 *  never starts, stops or steers an agent; agents then work from the project goal and conversations. */
export function NativeTeamSettings({ user, projectId, active, readOnly = false, onSaved }: { user: SessionUser; projectId: string; active: boolean; readOnly?: boolean; onSaved?: (value: Settings) => void }) {
  // Team settings are a person-scoped write: send the selected profile and fence the request to the signed-in account.
  const request = useCallback(async <T,>(path: string, body?: object) => authorizedRequest<T>(user, '/api/projects', path, body, await lookupOwnProfileId(user), () => session.currentUid()), [user]);
  const api = useMemo(() => ({ get: () => request<Settings>(`/${encodeURIComponent(projectId)}/native-team-settings`), save: (input: { clientRequestId: string; expectedRevision: number; enabled: boolean }) => request<Settings>(`/${encodeURIComponent(projectId)}/native-team-settings`, input) }), [projectId, request]);
  return <TaskSettingsControl api={api} active={active} readOnly={readOnly} onSaved={onSaved} feature="teams" />;
}
