import type { SessionUser } from './session-identity';
import type { NativeTeamDetail, NativeTeamPage } from '@minions/contracts';
import { authorizedRequest } from './authorized-request';

export function teamsApi(user: SessionUser, projectId: string, profileId?: string, currentUid?: () => string | undefined) {
  const root = `/${encodeURIComponent(projectId)}/teams`;
  const request = <T,>(path: string) => authorizedRequest<T>(user, '/api/projects', path, undefined, profileId, currentUid);
  return {
    list(archived: boolean, search: string, cursor?: string | null) {
      const query = new URLSearchParams({ archived: String(archived) });
      if (search.trim()) query.set('search', search.trim());
      if (cursor) query.set('cursor', cursor);
      return request<NativeTeamPage>(`${root}?${query}`);
    },
    get(id: string, cursors: { memberCursor?: string; activityCursor?: string } = {}) {
      const query = new URLSearchParams(cursors);
      return request<NativeTeamDetail>(`${root}/${encodeURIComponent(id)}${query.size ? `?${query}` : ''}`);
    },
  };
}
export type TeamsApi = ReturnType<typeof teamsApi>;
