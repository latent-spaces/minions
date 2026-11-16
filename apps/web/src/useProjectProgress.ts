import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionUser } from './session-identity';
import type { ProgressPage } from '@minions/contracts';
import { ApiError } from './api';
import { readProjectProgress } from './progress-api';

const newestFirst = (items: ProgressPage['items']) => [...new Map(items.map(item => [item.id, item])).values()]
  .sort((a, b) => b.publishedAt - a.publishedAt || b.id.localeCompare(a.id));

export function useProjectProgress(projectId: string, user: SessionUser, tick: number, active: boolean) {
  const scope = `${projectId}:${user.uid}`;
  const current = useRef({ scope, epoch: 0 });
  if (current.current.scope !== scope) current.current = { scope, epoch: current.current.epoch + 1 };
  const [state, setState] = useState<{ scope: string; page: ProgressPage | null; error: string | null }>({ scope, page: null, error: null });
  const [loading, setLoading] = useState(false);
  const page = state.scope === scope ? state.page : null;
  useEffect(() => {
    if (!active) return;
    const epoch = current.current.epoch;
    let cancelled = false;
    setLoading(true);
    readProjectProgress(projectId, user).then(next => {
      if (cancelled || current.current.scope !== scope || current.current.epoch !== epoch) return;
      setState(previous => {
        const older = previous.scope === scope ? previous.page : null;
        const items = newestFirst([...(older?.items ?? []), ...next.items]);
        const overlap = older && next.items.some(item => older.items.some(previousItem => previousItem.id === item.id));
        return { scope, error: null, page: { ...next, items, next: overlap && older.items.length > next.items.length ? older.next : next.next } };
      });
    }, error => {
      if (cancelled || current.current.scope !== scope || current.current.epoch !== epoch) return;
      const denied = error instanceof ApiError && [401, 403, 404].includes(error.status);
      if (denied) current.current.epoch++;
      setState(previous => ({ scope, page: denied ? null : previous.scope === scope ? previous.page : null, error: error instanceof Error ? error.message : 'Could not load updates.' }));
    }).finally(() => { if (!cancelled && current.current.scope === scope) setLoading(false); });
    return () => { cancelled = true; };
  }, [projectId, user, scope, active, tick]);
  const busy = useRef(false);
  const loadEarlier = useCallback(async (): Promise<ProgressPage | null> => {
    if (!page?.next || busy.current) return null;
    const epoch = current.current.epoch;
    busy.current = true; setLoading(true);
    setState(previous => previous.scope === scope ? { ...previous, error: null } : previous);
    try {
      const next = await readProjectProgress(projectId, user, page.next);
      if (current.current.scope !== scope || current.current.epoch !== epoch) return null;
      setState(previous => previous.scope !== scope ? previous
        : { scope, error: null, page: { ...next, items: newestFirst([...(previous.page?.items ?? []), ...next.items]) } });
      return next;
    } catch (error) {
      if (current.current.scope === scope && current.current.epoch === epoch) {
        const denied = error instanceof ApiError && [401, 403, 404].includes(error.status);
        if (denied) current.current.epoch++;
        setState(previous => ({ ...previous, page: denied ? null : previous.page,
          error: error instanceof Error ? error.message : 'Could not load earlier updates.' }));
      }
      return null;
    } finally { busy.current = false; if (current.current.scope === scope) setLoading(false); }
  }, [projectId, user, scope, page?.next]);
  return { page, loading, error: state.scope === scope ? state.error : null, loadEarlier };
}
