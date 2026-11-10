import type { SessionUser } from './session-identity';
import { session } from './api';
import { authorizedRequest } from './authorized-request';
export type FeedbackRequest = <T>(path: string, body?: object, profileId?: string) => Promise<T>;
export const feedbackRequest = (user: SessionUser): FeedbackRequest => (path, body, profileId) => authorizedRequest(user, '/api/feedback', path, body, profileId, () => session.currentUid());
