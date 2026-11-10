import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionUser } from './session-identity';
import type { MergePolicyView, ProjectMergePolicy } from '@mlswarm/contracts';
import { ApiError, session, projects } from './api';

type Edit = { client_request_id: string; expected_revision: number; mode: ProjectMergePolicy['mode']; selected_profile_ids: string[] };
/** One reader and retry-safe writer for Merge rules. */
export function useProjectMergeAccess({ user, projectId, role, closed, active, refreshKey = 0, onSaved }: {
  user: SessionUser; projectId: string; role: string; closed: boolean; active: boolean; refreshKey?: number; onSaved?: () => void;
}) {
  const scope = `${user.uid}:${projectId}`, manager = role === 'owner';
  const current = useRef(scope); current.current = scope;
  const generation = useRef(0), lock = useRef(false), savedCallback = useRef(onSaved); savedCallback.current = onSaved;
  const [state, setState] = useState<{ scope: string; value: MergePolicyView } | null>(null);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [loading, setLoading] = useState(false), [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ scope: string; body: Edit } | null>(null);
  const value = active && state?.scope === scope ? state.value : null;
  const request = useCallback(<T,>(body?: Edit) => {
    if (session.currentUid() !== user.uid) return Promise.reject(new ApiError(401, 'Your signed-in account changed. Reload the project.'));
    return projects<T>(user, `/${projectId}/merge-access`, body);
  }, [user, projectId]);
  const load = useCallback(async (duringSave = false) => {
    if (!active || role === 'guest' || lock.current && !duringSave) return;
    const version = ++generation.current;
    setLoading(true);
    try {
      const result = await request<MergePolicyView>();
      if (current.current !== scope || version !== generation.current) return;
      setState({ scope, value: result }); setError('');
    } catch (failure) {
      if (current.current !== scope || version !== generation.current) return;
      // A saved policy must not remain an actionable grant surface after a failed read.
      setState(null); setError(failure instanceof Error ? failure.message : 'Could not load merge access.');
    } finally { if (current.current === scope && version === generation.current) setLoading(false); }
  }, [request, scope, active, role]);
  useEffect(() => { setPending(null); setError(''); setNotice(''); setBusy(false); }, [scope]);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === 'visible') void load(); };
    const timer = active ? window.setInterval(refresh, 10_000) : undefined;
    window.addEventListener('focus', refresh);
    return () => { generation.current++; clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [load]);
  useEffect(() => { void load(); }, [refreshKey, load]);
  async function execute(body: Edit) {
    if (lock.current || !active || !manager || closed) return;
    lock.current = true; generation.current++; setPending({ scope, body }); setBusy(true); setError(''); setNotice('');
    try {
      await request(body);
      if (current.current !== scope) return;
      setPending(null); setNotice('Merge access saved. GitHub synchronization may still be pending.');
      savedCallback.current?.(); await load(true);
    } catch (failure) {
      if (current.current !== scope) return;
      const message = failure instanceof Error ? failure.message : 'Could not confirm merge access. Retry the original change.';
      if (failure instanceof ApiError && failure.status < 500 && ![408, 429].includes(failure.status)) { setPending(null); await load(true); }
      setError(message);
    } finally { lock.current = false; if (current.current === scope) setBusy(false); }
  }
  function save(mode: ProjectMergePolicy['mode'], selected = value?.policy.selected.map(row => row.profileId) ?? []) {
    if (!value || loading || pending?.scope === scope) return;
    void execute({ client_request_id: crypto.randomUUID(), expected_revision: value.policy.revision, mode, selected_profile_ids: mode === 'existing' ? [] : [...new Set(selected)].sort() });
  }
  const refresh = useCallback(() => { void load(); }, [load]);
  return { value, error, notice, loading, busy, editable: manager && !closed,
    locked: busy || loading || pending?.scope === scope,
    pending: pending?.scope === scope ? pending.body : null,
    save, toggle(personId: string, allow: boolean) { const selected = value?.policy.selected.map(row => row.profileId) ?? []; save('selected_people', allow ? [...selected, personId] : selected.filter(id => id !== personId)); },
    refresh, retry: () => { if (pending?.scope === scope) void execute(pending.body); },
    discard: () => { if (!busy) { setPending(null); setError(''); void load(); } },
  };
}
export type MergeAccessActions = ReturnType<typeof useProjectMergeAccess>;
