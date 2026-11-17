import { useCallback, useEffect, useState } from 'react';
import type { SessionUser } from '../session-identity';
import type { CommunityAccount } from '../community-api';
import { session, community } from '../api';
import { createProfileLookup } from './profile-lookup';

const profiles = createProfileLookup();
/** This account's profile id from `/community/me`, fetched once per uid and shared by every caller on the page. */
export const ownProfileId = (user: SessionUser) => profiles.lookup(user.uid, () => community<CommunityAccount>(user, '/me').then(account => account.person.id));

/**
 * The invited profile that fences Needs you reads and answers: the Needs you inbox and the notifications bell both
 * discover it from `/community/me` before any request. `retry` looks it up again (the last error stays shown until
 * the new lookup answers); `deny` drops it after the service refused it, keeping the refusal as the error.
 */
export function useInvitedProfile(user: SessionUser) {
  const [state, setState] = useState<{ uid: string; profileId: string | null; error: string | null }>(() => ({ uid: user.uid, profileId: null, error: null }));
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    ownProfileId(user).then(id => {
      if (current && session.currentUid() === user.uid) setState({ uid: user.uid, profileId: id, error: null });
    }, failure => {
      if (current && session.currentUid() === user.uid) setState({ uid: user.uid, profileId: null, error: failure.message });
    });
    return () => { current = false; };
  }, [user.uid, attempt]);
  const retry = useCallback(() => {
    if (session.currentUid() !== user.uid) return;
    profiles.forget(user.uid);
    setState(previous => ({ uid: user.uid, profileId: null, error: previous.uid === user.uid ? previous.error : null }));
    setAttempt(n => n + 1);
  }, [user.uid]);
  const deny = useCallback((failure: Error) => {
    if (session.currentUid() !== user.uid) return;
    profiles.forget(user.uid); setState({ uid: user.uid, profileId: null, error: failure.message });
  }, [user.uid]);
  // Effects run after render: an account switch must immediately hide the prior
  // person's profile, before any consumer can combine it with the new token.
  return { profileId: state.uid === user.uid ? state.profileId : null,
    error: state.uid === user.uid ? state.error : null, retry, deny };
}
