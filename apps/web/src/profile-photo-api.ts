import type { SessionUser } from './session-identity';
import { ApiError, session } from './api';
export type PublicPhoto = import('@mlswarm/contracts').PublicProfilePhoto;
export type PhotoCandidate = import('@mlswarm/contracts').ProfilePhotoCandidate;
export type PhotoSelection = { id: string; publicConsent: true } | null;
export async function profilePhotoRequest(user: SessionUser, personId: string, path: string, body?: File | object, requestId?: string): Promise<Response> {
  const token = await user.getIdToken();
  if (session.currentUid() !== user.uid) throw new ApiError(401, 'Your signed-in account changed.');
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: {
    authorization: `Bearer ${token}`, 'X-Mlswarm-Profile-Id': personId,
    ...(body instanceof File ? { 'content-type': body.type, 'X-Upload-Id': requestId! } : body ? { 'content-type': 'application/json' } : {}),
  }, body: body instanceof File ? body : body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000) });
  if (session.currentUid() !== user.uid) throw new ApiError(401, 'Your signed-in account changed.');
  if (!response.ok) { const data = await response.json().catch(() => null); throw new ApiError(response.status, data?.message ?? 'Could not prepare your photo. Try again.'); }
  return response;
}
export async function saveProfile(user: SessionUser, personId: string, body: object) {
  const { person_id: _identity, ...payload } = body as object & { person_id?: string };
  return (await profilePhotoRequest(user, personId, '/community/my-profile', payload)).json();
}
