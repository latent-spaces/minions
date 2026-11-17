import { useContext, useEffect, useRef, useState } from 'react';
import type { SessionUser } from './session-identity';
import { ApiError, read, ProjectScope } from './api';
import { readAllPages, walkDue, type PageWalk } from './all-pages';

type WalkPace = Pick<PageWalk<unknown>, 'pages' | 'startedAt'>;

// Labels that must cover the whole project (task assignees, contributors, comment authors) cannot come from
// a directory's first page. Pages are read in order up to a bound; until the first walk finishes, the caller's
// first page stands in. A walk stopped by the bound keeps every row it read rather than reverting to the first
// page. Ticks start a new walk only when walkDue allows, so large projects stay within the shared read budget.
// A failed walk keeps the last list, except when access is lost.
export function useAllPages<T extends { id: string }>(user: SessionUser | null, path: (cursor: string | null) => string, field: 'agents' | 'members', firstPage: T[], tick: number, active: boolean, refreshMs: number): T[] {
  const projectId = useContext(ProjectScope);
  const scope = JSON.stringify([user?.uid ?? 'guest', projectId, path(null)]);
  const [result, setResult] = useState<{ scope: string; items: T[] } | null>(null);
  const refresh = useRef<(() => void) | null>(null);
  // Pacing survives leaving and reopening the tab, so switching views cannot restart a long walk early.
  // A failed walk is paced by the pages it read, so a refusal partway does not trigger a full re-walk next tick.
  const lastWalk = useRef<{ scope: string; walk: WalkPace } | null>(null);
  useEffect(() => {
    if (!active) return;
    let cancelled = false, reading = false;
    const readPage = async (cursor: string | null) => {
      const body = await read<{ next: string | null } & Partial<Record<typeof field, T[]>>>(user, path(cursor), projectId);
      return { items: body[field] ?? [], next: body.next };
    };
    const load = () => {
      if (cancelled || reading || !walkDue(lastWalk.current?.scope === scope ? lastWalk.current.walk : null, Date.now(), refreshMs)) return;
      reading = true;
      const startedAt = Date.now();
      let pages = 0;
      void readAllPages(cursor => { pages++; return readPage(cursor); }, () => cancelled).then(walk => {
        if (cancelled || walk === null) return;
        lastWalk.current = { scope, walk };
        setResult({ scope, items: walk.items });
      }, (failure: unknown) => {
        // Access loss also suppresses a stale first page until successful revalidation.
        if (cancelled) return;
        if (failure instanceof ApiError && [401, 403, 404].includes(failure.status)) { lastWalk.current = null; setResult({ scope, items: [] }); }
        else lastWalk.current = { scope, walk: { pages, startedAt } };
      }).finally(() => { reading = false; });
    };
    refresh.current = load;
    load();
    return () => { cancelled = true; refresh.current = null; };
  }, [scope, active, refreshMs]);
  // Polling asks the current walk to refresh without cancelling a slow in-flight page.
  useEffect(() => { if (active) refresh.current?.(); }, [tick]);
  const shown = result?.scope === scope ? result : null;
  // Once read, this snapshot is authoritative: an older first page cannot revive removed rows.
  return shown ? shown.items : firstPage;
}
