import { useQuery, useQueryClient } from '@tanstack/react-query';
import { refreshAfterChange } from '../refresh-after-change';
import { useEffect } from 'react';
import type { SessionUser } from '../session-identity';
import type { HumanRequestPage } from '@minions/contracts';
import { needsYou } from '../api';
import { subscribeRealtime, RECONCILE_MS } from '../realtime';

export const needsYouKey = (uid: string, profileId: string, search: string) => ['needs-you', uid, profileId, search] as const;

/** The latest page of a Needs you list. The bell and the Needs you inbox read the same open requests, so
 * they share one read, one poll and one realtime refresh. */
export function useNeedsYouPage(user: SessionUser, profileId: string | null, search: string, { enabled = true, projectId }: { enabled?: boolean; projectId?: string } = {}) {
  const client = useQueryClient(), live = enabled && !!profileId;
  const query = useQuery({ queryKey: needsYouKey(user.uid, profileId ?? '', search), queryFn: () => needsYou<HumanRequestPage>(user, profileId!, search), enabled: live, refetchInterval: RECONCILE_MS });
  useEffect(() => {
    if (!live) return;
    return subscribeRealtime(user, projectId, topics => {
      if (topics.includes('needs-you') && document.visibilityState !== 'hidden') void refreshAfterChange(client, needsYouKey(user.uid, profileId!, search));
    });
  }, [client, user, profileId, search, projectId, live]);
  return query;
}
