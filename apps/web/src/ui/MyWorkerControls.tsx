import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { SessionUser } from '../session-identity';
import type { ProjectWorkersView } from '@minions/contracts';
import { ApiError, session as signedIn, projects } from '../api';
import { useChatParticipationControls } from './ChatParticipationControls';
import { useBackgroundWorkerControls } from './BackgroundWorkerControls';
import { refreshOnReturn } from '../refresh-on-return';

// The person's own agents in the open project, queued ones included: the one source every project screen reads.
// The project page loads it once (App) and provides it here; nothing else fetches its own copy.
export type MyWorkers = ReturnType<typeof useMyWorkerControls>;
export const MyWorkersContext = createContext<MyWorkers | null>(null);
export const useMyWorkers = () => useContext(MyWorkersContext);
export function useMyWorkerControls(user: SessionUser, projectId: string | null, active: boolean, pollMs = 15000) {
  const [data, setData] = useState<ProjectWorkersView | null>(null), [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [clock, setClock] = useState(Date.now()), [refresh, setRefresh] = useState(0);
  const offset = useRef(0);
  const background = useBackgroundWorkerControls(user, projectId, () => setRefresh(v => v + 1));
  const participation = useChatParticipationControls(user, projectId, (agentId, value) => {
    if (agentId && value) setData(current => current ? { ...current, agents: current.agents.map(row => row.agentId === agentId ? { ...row, participation: value } : row) } : current);
    setRefresh(v => v + 1);
  });
  useEffect(() => { setData(null); setError(''); }, [user.uid, projectId]);
  useEffect(() => {
    if (!projectId || !active) return;
    let cancelled = false, loading = false;
    const load = async () => {
      if (loading) return; loading = true; setLoading(true);
      try {
        const reply = await projects<ProjectWorkersView>(user, `/${projectId}/my-workers`);
        if (!cancelled && signedIn.currentUid() === user.uid) { offset.current = reply.serverTime - Date.now(); setData(reply); setError(''); }
      } catch (failure) { if (!cancelled) { setError(failure instanceof Error ? failure.message : 'Could not load your agents.'); if (!(failure instanceof ApiError && failure.status === 429)) setData(null); } }
      finally { loading = false; if (!cancelled) setLoading(false); }
    };
    void load(); const poll = setInterval(() => void load(), pollMs), timer = setInterval(() => setClock(Date.now()), 1000);
    const stop = refreshOnReturn(() => void load());
    return () => { cancelled = true; clearInterval(poll); clearInterval(timer); stop(); };
  }, [user, projectId, active, refresh, pollMs]);
  return { data, error, loading, participation, background, now: clock + offset.current, refresh: () => setRefresh(v => v + 1) };
}
