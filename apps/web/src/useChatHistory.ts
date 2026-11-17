import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from './api';
import { mergeChatMessages, mergeLatestChatWindow, type ChatHistoryMessage } from './chat-history';

export type ChatWindow<M> = { messages: M[]; next: string | null };
// Pages are accumulated chronologically. A burst that skips a whole window is bridged
// before it is displayed, so the UI never silently presents a discontinuous history.
export function useChatHistory<M extends ChatHistoryMessage, P extends ChatWindow<M>>(fetchPage: (cursor: string | null) => Promise<P>, active: boolean, tick = 0, reconcileMs = 5000) {
  const [page, setPage] = useState<P | null>(null), [messages, setMessages] = useState<M[]>([]);
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false), [gap, setGap] = useState(false), [accessDenied,setAccessDenied] = useState(false);
  const [revision, setRevision] = useState(0);
  const state = useRef<M[]>([]), next = useRef<string | null>(null), initialized = useRef(false), alive = useRef(true), epoch = useRef(0), locked = useRef(false), denied = useRef(false);
  const queued = useRef(false), observedTick = useRef({tick, revision});
  const bridge = useRef<{ page: P; messages: M[]; cursor: string | null } | null>(null);
  const commit = (items: M[]) => { state.current = items; setMessages(items); };
  const refuse = (failure: unknown) => {
    if (failure instanceof ApiError && [401,403,404].includes(failure.status)) { denied.current = true; setAccessDenied(true); bridge.current = null; initialized.current = false; next.current = null; commit([]); setPage(null); setGap(false); }
    setError(failure instanceof Error ? failure.message : 'Could not refresh messages. Try again.');
  };
  async function refresh(at: number) {
    if (denied.current) return;
    if (locked.current) { queued.current = true; return; }
    locked.current = true;
    try {
      let pending = bridge.current;
      if (!pending) { const incoming = await fetchPage(null); if (!alive.current || at !== epoch.current) return; pending = { page: incoming, messages: incoming.messages, cursor: incoming.next }; }
      let merged = mergeLatestChatWindow(state.current, pending.messages, { hasOlder: !!pending.cursor });
      for (let count = 0; initialized.current && merged.gap && pending.cursor && count < 3; count++) {
        const older = await fetchPage(pending.cursor); if (!alive.current || at !== epoch.current) return;
        pending = { ...pending, messages: mergeChatMessages(pending.messages,older.messages), cursor: older.next };
        merged = mergeLatestChatWindow(state.current,pending.messages,{hasOlder:!!pending.cursor});
      }
      if (initialized.current && merged.gap) { bridge.current = pending; setGap(true); setError(null); return; }
      bridge.current = null; setGap(false);
      if (!initialized.current) { next.current = pending.cursor; initialized.current = true; }
      else if (!pending.cursor) next.current = null;
      setPage({ ...pending.page, next: next.current }); commit(merged.messages); setError(null); setAccessDenied(false);
    } catch (failure) { if (alive.current && at === epoch.current) refuse(failure); }
    finally { if (at === epoch.current) { locked.current = false; setBusy(false); if (queued.current) { queued.current = false; void refresh(at); } } }
  }
  useEffect(() => {
    alive.current = true; denied.current = false; const at = ++epoch.current; locked.current = false; queued.current = false;
    if (!active) return () => { alive.current = false; ++epoch.current; };
    void refresh(at);
    const timer = setInterval(() => { if (document.visibilityState === 'visible' && !bridge.current) void refresh(at); },reconcileMs);
    return () => { alive.current = false; ++epoch.current; clearInterval(timer); };
  }, [fetchPage,active,reconcileMs]);
  useEffect(() => { const previous = observedTick.current; observedTick.current = {tick, revision}; if (active && (previous.tick !== tick || previous.revision !== revision)) { denied.current = false; void refresh(epoch.current); } }, [tick,revision]);
  const older = async () => {
    if (locked.current || !next.current || denied.current) return;
    const at = epoch.current; locked.current = true; setBusy(true);
    try { const incoming = await fetchPage(next.current); if (!alive.current || at !== epoch.current) return;
      next.current = incoming.next; commit(mergeChatMessages(incoming.messages,state.current)); setPage(current => current && ({...current,next:incoming.next})); setError(null);
    } catch (failure) { if (alive.current && at === epoch.current) refuse(failure); }
    finally { if (at === epoch.current) { locked.current = false; setBusy(false); if (queued.current) { queued.current = false; void refresh(at); } } }
  };
  const reload = useCallback(() => setRevision(value => value + 1), []);
  return { page, messages, error, busy, gap, accessDenied, older, reload, bridgeGap: () => { setBusy(true); void refresh(epoch.current); } };
}
