import type { SessionUser } from './session-identity';
import type { ProgressPage, ProgressScreenshot } from '@mlswarm/contracts';
import { ApiError } from './authorized-request';

const base = (projectId: string) => `/api/project-progress/${projectId}`;
async function result<T>(response: Response): Promise<T> {
  const value = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, value?.message ?? 'Could not load the project updates. Try again.');
  return value as T;
}
// Reads the project's Updates feed. Agents publish to it; the website only reads it (owner, 10 November 2026).
export function createProgressClient(currentUid: () => string | undefined) {
  async function request<T>(user: SessionUser, path: string, init: RequestInit = {}, decode: (response: Response) => Promise<T> = result): Promise<T> {
    const checkAccount = () => { if (currentUid() !== user.uid) throw new ApiError(401, 'Your signed-in account changed.'); };
    checkAccount();
    const token = await user.getIdToken();
    checkAccount();
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${token}`);
    try {
      return await decode(await fetch(path, { ...init, headers }));
    } finally {
      // JSON and image bodies can finish after an account switch, even if headers arrived earlier.
      checkAccount();
    }
  }
  return {
    readProjectProgress(projectId: string, user: SessionUser, cursor?: string): Promise<ProgressPage> {
      const query = new URLSearchParams(cursor ? { cursor } : {});
      return request(user, `${base(projectId)}${query.size ? `?${query}` : ''}`);
    },
    readProjectScreenshot(projectId: string, user: SessionUser, screenshot: ProgressScreenshot): Promise<Blob> {
      return request(user, `${base(projectId)}/media/${encodeURIComponent(screenshot.id)}`, { cache: 'no-store' }, async response => {
        if (!response.ok) { await result(response); throw new Error('This image could not be loaded.'); }
        return response.blob();
      });
    },
  };
}
