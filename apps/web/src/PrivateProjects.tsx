import { useCallback, useEffect, useState } from 'react';
import type { SessionUser } from './session-identity';
import { ApiError, community, privateProjects } from './api';
import type { CommunityAccount } from './community-api';

// Keep a browser draft bound to the profile loaded on this screen, even if the same Auth UID later
// signs in as a different profile.
export function usePrivateProjectRequest(user: SessionUser, enabled = true) {
  const [profileId, setProfileId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    if (!enabled || profileId) return;
    let current = true;
    setError(null);
    setChecking(true);
    community<CommunityAccount>(user, '/me').then(account => {
      if (current) {
        setProfileId(account.person.id);
        setError(null);
        setChecking(false);
      }
    }, failure => {
      if (current) {
        setError(failure.message);
        setChecking(false);
      }
    });
    return () => { current = false; };
  }, [user, enabled, profileId, attempt]);
  const retry = useCallback(() => {
    if (!profileId && !checking) setAttempt(value => value + 1);
  }, [profileId, checking]);
  const request = useCallback(<T,>(path: string, body?: object): Promise<T> => profileId
    ? privateProjects<T>(user, profileId, path, body)
    : Promise.reject(new ApiError(401, error ?? 'Wait for your account to be checked.')), [user, profileId, error]);
  return { request, ready: !!profileId, error, checking, retry };
}
