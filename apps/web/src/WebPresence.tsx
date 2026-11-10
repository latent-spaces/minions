import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { SessionUser } from './session-identity';
import type { WebPresencePage } from '@mlswarm/contracts';
import { authorizedRequest } from './authorized-request';
import { session } from './api';
import { PersonPresence } from './ui/person-presence';

/** One batch poll for the visible avatars and a heartbeat for this browser account. */
export function WebPresence({ user, profileId, children }: { user: SessionUser; profileId: string; children: ReactNode }) {
  const elements = useRef(new Map<string, Set<HTMLElement>>());
  const [deadlines, setDeadlines] = useState<ReadonlyMap<string, number>>(new Map());
  const [now, setNow] = useState(Date.now());
  const refresh = useRef(() => {});
  const register = useCallback((id: string, element: HTMLElement) => {
    let group = elements.current.get(id);
    if (!group) { group = new Set(); elements.current.set(id, group); }
    group.add(element);
    refresh.current();
    return () => { group.delete(element); if (!group.size) elements.current.delete(id); };
  }, []);
  useEffect(() => {
    let stopped = false, busy = false, scheduled: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      if (stopped || busy || document.visibilityState !== 'visible' || !navigator.onLine) return;
      busy = true;
      try {
        const ids = [...elements.current].filter(([, nodes]) => [...nodes].some(node => node.getClientRects().length > 0)).map(([id]) => id);
        // Keep every request bounded even on long discussions. Duplicate avatars share an ID.
        for (let start = 0; start < Math.max(1, ids.length); start += 100) {
          if (stopped || document.visibilityState !== 'visible') break;
          const requestedAt = Date.now();
          const page = await authorizedRequest<WebPresencePage>(user, '/community', '/web-presence',
            { profileIds: ids.slice(start, start + 100) }, profileId, () => session.currentUid(), AbortSignal.timeout(15_000));
          if (stopped) break;
          setDeadlines(previous => {
            const next = new Map(previous);
            // Prune unmounted identities; a failed poll never extends an observation.
            for (const id of next.keys()) if (!elements.current.has(id)) next.delete(id);
            for (const [id, presence] of Object.entries(page.people)) {
              next.set(id, presence.online && presence.freshUntil !== null ? requestedAt + Math.max(0, presence.freshUntil - page.generatedAt) : 0);
            }
            return next;
          });
          setNow(Date.now());
        }
      } catch { /* Existing observations expire to gray; no optimistic online claim. */ }
      finally { busy = false; }
    };
    // Coalesce avatars mounting in one render into one request.
    refresh.current = () => { if (!scheduled) scheduled = setTimeout(() => { scheduled = undefined; void check(); }, 100); };
    const changed = () => { setNow(Date.now()); refresh.current(); };
    refresh.current();
    const poll = setInterval(() => void check(), 15_000), clock = setInterval(() => setNow(Date.now()), 1000);
    document.addEventListener('visibilitychange', changed); window.addEventListener('online', changed); window.addEventListener('focus', changed);
    return () => {
      stopped = true; refresh.current = () => {}; clearTimeout(scheduled); clearInterval(poll); clearInterval(clock);
      document.removeEventListener('visibilitychange', changed); window.removeEventListener('online', changed); window.removeEventListener('focus', changed);
    };
  }, [user, profileId]);
  const value = useMemo(() => ({ register, deadlines, now }), [register, deadlines, now]);
  return <PersonPresence.Provider value={value}>{children}</PersonPresence.Provider>;
}
