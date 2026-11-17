import { useCallback, useMemo } from 'react';
import type { NativeTaskSettings as Settings } from '@minions/contracts';
import type { SessionUser } from '../session-identity';
import { session } from '../api';
import { authorizedRequest } from '../authorized-request';
import { ownProfileId as lookupOwnProfileId } from './use-invited-profile';
import { TaskSettingsControl } from './TaskSettingsControl';
import './project-tasks.css';

/** Project tasks on/off (owner only; on by default). Turning tasks off keeps every task, comment and assignment and
 *  never starts, stops or steers an agent; agents then work from the project goal and conversations. */
export function NativeTaskSettings({ user, projectId, active, readOnly = false, onSaved }: { user: SessionUser; projectId: string; active: boolean; readOnly?: boolean; onSaved?: (value: Settings) => void }) {
  // Task settings are a person-scoped write: send the selected profile and fence the request to the signed-in account.
  const request = useCallback(async <T,>(path: string, body?: object) => authorizedRequest<T>(user, '/api/projects', path, body, await lookupOwnProfileId(user), () => session.currentUid()), [user]);
  const api = useMemo(() => ({ get: () => request<Settings>(`/${encodeURIComponent(projectId)}/native-task-settings`), save: (input: { clientRequestId: string; expectedRevision: number; enabled: boolean }) => request<Settings>(`/${encodeURIComponent(projectId)}/native-task-settings`, input) }), [projectId, request]);
  return <TaskSettingsControl api={api} active={active} readOnly={readOnly} onSaved={onSaved} />;
}
