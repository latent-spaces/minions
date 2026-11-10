import type { SessionUser } from './session-identity';
import { hostingProjectLabel, type HostingArtifact, type HostingSummary } from '@mlswarm/contracts';
import { authorizedRequest } from './authorized-request';

export function createHostingClient(user: SessionUser, projectId: string, profileId: string, currentUid: () => string | undefined) {
  const root = `/${encodeURIComponent(projectId)}`;
  const call = <T,>(path: string, body?: object) => authorizedRequest<T>(user, '/api/project-hosting', root + path, body, profileId, currentUid);
  return {
    read: (cursor?: string) => call<HostingSummary>(cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''),
    candidate: (id: string) => call<{ candidateId: string; artifact: HostingArtifact }>(`/candidates/${encodeURIComponent(id)}`),
    configure: (input: object) => call('/policy', input),
    publish: (candidateId: string, policyRevision: number, clientRequestId: string) => call('/publications', { candidateId, policyRevision, clientRequestId }),
    unpublish: (clientRequestId: string) => call('/unpublish', { clientRequestId }),
    retry: (operationId: string) => call(`/operations/${operationId}/retry`, {}),
  };
}
export function isolatedHostingUrl(raw: string | null, projectId: string, appOrigin: string): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw), labels = url.hostname.split('.');
    if (url.protocol !== 'https:' || url.origin === appOrigin || url.port || url.username || url.password || url.search || url.hash
      || labels[0] !== hostingProjectLabel(projectId) || labels.length < 3
      || !/^\/_releases\/[a-f0-9]{64}\/$/.test(url.pathname)) return null;
    return url.href;
  } catch { return null; }
}
