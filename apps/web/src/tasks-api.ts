import type { SessionUser } from './session-identity';
import type { NativeTaskDetail, NativeTaskMutation, NativeTaskMutationResult, NativeTaskPage, NativeTaskStatus } from '@minions/contracts';
import { authorizedRequest } from './authorized-request';

/** Requests carry the selected profile and are fenced to the signed-in account, like other person-scoped project writes. */
export function tasksApi(user: SessionUser, projectId: string, ownProfileId?: string, currentUid?: () => string | undefined) {
  const base = '/api/projects', root = `/${encodeURIComponent(projectId)}/tasks`;
  const request = <T,>(path: string, body?: object) => authorizedRequest<T>(user, base, path, body, ownProfileId, currentUid);
  return {
    list: (cursor?: string | null, status?: NativeTaskStatus, assignedAgentId?: string | null, search?: string) => {
      const query = new URLSearchParams();
      if (cursor) query.set('cursor', cursor);
      if (status) query.set('status', status);
      if (search?.trim()) query.set('search', search.trim());
      if (assignedAgentId === null) query.set('unassigned', 'true');
      else if (assignedAgentId !== undefined) query.set('assignedAgentId', assignedAgentId);
      return request<NativeTaskPage>(`${root}${query.size ? `?${query}` : ''}`);
    },
    get: (taskId: string, cursors: { commentCursor?: string | null; activityCursor?: string | null; activityOrder?: 'asc' | 'desc'; activityId?: string } = {}) => {
      const query = new URLSearchParams();
      if (cursors.activityId) query.set('activityId', cursors.activityId);
      if (cursors.commentCursor) query.set('commentCursor', cursors.commentCursor);
      if (cursors.activityCursor) query.set('activityCursor', cursors.activityCursor);
      if (cursors.activityOrder === 'desc') query.set('activityOrder', 'desc');
      return request<NativeTaskDetail>(`${root}/${encodeURIComponent(taskId)}${query.size ? `?${query}` : ''}`);
    },
    mutate: (mutation: NativeTaskMutation) => request<NativeTaskMutationResult>(root, mutation),
  };
}
export * from './task-model';
