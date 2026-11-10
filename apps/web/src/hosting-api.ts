import type { SessionUser } from './session-identity';
import { session } from './api';
import { createHostingClient } from './hosting-client';
export { isolatedHostingUrl } from './hosting-client';
export const hostingApi = (user: SessionUser, projectId: string, profileId: string) =>
  createHostingClient(user, projectId, profileId, () => session.currentUid());
