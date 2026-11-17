import { useEffect, useRef, useState } from 'react';
import type { SessionUser } from '../session-identity';
import type { ProjectUsage as Usage } from '@minions/contracts';
import { ApiError, read } from '../api';

/** Reads the project's reported token usage while `active`, rereading on each tick. A denied
 *  read clears it; another failure keeps the previous value. */
export function useProjectUsage(user: SessionUser, projectId: string, active: boolean, tick: number): Usage | null {
  const scope = `${user.uid}:${projectId}`;
  const [state, setState] = useState<{ scope: string; usage: Usage | null }>({ scope, usage: null });
  const refresh = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!active) return;
    let cancelled = false, busy = false;
    const load = () => {
      if (cancelled || busy) return;
      busy = true;
      read<Usage>(user, '/usage', projectId).then(usage => {
        if (!cancelled) setState({ scope, usage });
      }, error => {
        if (cancelled) return;
        const denied = error instanceof ApiError && [401, 403, 404].includes(error.status);
        setState(previous => ({ scope, usage: denied || previous.scope !== scope ? null : previous.usage }));
      }).finally(() => { busy = false; });
    };
    refresh.current = load; load();
    return () => { cancelled = true; refresh.current = null; };
  }, [scope, user, projectId, active]);
  useEffect(() => { if (active) refresh.current?.(); }, [tick, active]);
  return state.scope === scope ? state.usage : null;
}
