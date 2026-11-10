import { session } from './api';
import { authorizedRequest } from './authorized-request';

/** Sharing always targets the viewer, independent of the page the menu is on. */
export async function sharedLink(path: string): Promise<string> {
  const url = new URL(path, window.location.origin);
  if (url.origin !== window.location.origin) throw new Error('Choose a MyLittleSwarm page to share.');
  const user = session.currentUser();
  if (!user) throw new Error('Sign in to share this page.');
  const result = await authorizedRequest<{ path: string }>(user, '/api/shared-links', '', { path: url.pathname + url.search }, undefined, () => session.currentUid());
  if (!/^\/s\/[A-Za-z0-9_-]{22}$/.test(result.path)) throw new Error('Could not create a shared link. Try again.');
  return new URL(result.path, window.location.origin).href;
}
