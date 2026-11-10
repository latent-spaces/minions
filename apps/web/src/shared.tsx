import { Button } from './ui/Button';
// Pieces the viewer's pages share: real links, bounded pages and observation times.
import type { SessionUser } from './session-identity';
import { useContext, useEffect, useRef, useState } from 'react';
import { ApiError, read, ProjectScope } from './api';

export { NavLink } from './navigation-link';

// One bounded page at a time, with the cursors of the pages before it. Cursors and the shown page
// belong to one path: a different path starts at its first page and never shows the previous results.
export function usePages<T>(user: SessionUser | null, path: (cursor: string | null) => string | null, tick: number, active: boolean) {
  const projectId = useContext(ProjectScope);
  const first = path(null);
  // A relative URL alone does not identify a result: accounts and projects must
  // never inherit each other's cached page or pagination cursor.
  const scope = JSON.stringify([user?.uid ?? 'guest', projectId, first]);
  const [paging, setPaging] = useState<{ scope: string; cursors: (string | null)[] }>({ scope, cursors: [null] });
  const [result, setResult] = useState<{ key: string; page: { items: T[]; next: string | null; serverTime: number; count: number | null } | null; error: string | null } | null>(null);
  if (paging.scope !== scope) setPaging({ scope, cursors: [null] });
  const cursors = paging.scope === scope ? paging.cursors : [null];
  const url = path(cursors[cursors.length - 1]);
  const key = JSON.stringify([scope, url]);
  const refresh = useRef<(() => void) | null>(null);
  const observedTick = useRef(tick);

  useEffect(() => {
    if (!active || url === null) return;
    let cancelled = false, loading = false, queued = false;
    const load = () => {
      if (cancelled) return;
      if (loading) { queued = true; return; }
      loading = true;
      void read<{ next: string | null; serverTime: number } & Record<string, unknown>>(user, url, projectId).then(body => {
        if (!cancelled) setResult({ key, page: { items: (body.agents ?? body.messages ?? body.conversations ?? body.tasks ?? body.members) as T[], next: body.next, serverTime: body.serverTime,
          count: typeof body.count === 'number' ? body.count : null }, error: null });
      }, (e: Error) => {
        if (!cancelled) setResult(previous => ({ key,
          page: !(e instanceof ApiError && [401,403,404].includes(e.status)) && previous?.key === key ? previous.page : null,
          error: e.message }));
      }).finally(() => { loading = false; if (queued && !cancelled) { queued = false; load(); } });
    };
    refresh.current = load;
    load();
    return () => { cancelled = true; refresh.current = null; };
  }, [user, projectId, url, active, key]);
  // A tick requests a refresh; it must not cancel a slow in-flight read and
  // restart it forever when network latency exceeds the polling interval.
  useEffect(() => { const changed = observedTick.current !== tick; observedTick.current = tick; if (active && changed) refresh.current?.(); }, [tick]);

  const shown = result?.key === key ? result : null;
  const page = shown?.page ?? null;
  return {
    page, error: shown?.error ?? null, first: cursors.length === 1,
    older: () => page?.next && setPaging({ scope, cursors: [...cursors, page.next] }),
    newer: () => setPaging({ scope, cursors: cursors.length > 1 ? cursors.slice(0, -1) : cursors }),
  };
}

export function Pager({ first, hasNext, onBack, onNext, nextLabel = 'Next' }: {
  first: boolean, hasNext: boolean, onBack: () => void, onNext: () => void, nextLabel?: string,
}) {
  if (first && !hasNext) return null;
  return (
    <div className="pager">
      <Button className="soft" disabled={first} onClick={onBack}>Back</Button>
      <Button className="soft" disabled={!hasNext} onClick={onNext}>{nextLabel}</Button>
    </div>
  );
}

// How long before `now`, within a day. A page passes the service's own time of the observation,
// so a wrong clock on this computer does not change the age.
export { ago, time } from './observation-time';
