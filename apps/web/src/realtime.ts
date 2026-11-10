import { useEffect, useState } from 'react';
import type { SessionUser } from './session-identity';
import { session } from './api';
import { realtimeParser, type RealtimeTopic } from './realtime-events';

type Subscriber = (topics: RealtimeTopic[]) => void;
type Connection = { subscribers: Set<Subscriber>; close: () => void };
const connections = new Map<string, Connection>();
export const RECONCILE_MS = 60000;

// Fetch keeps credentials in the Authorization header. Native EventSource would
// require a different authentication contract. One stream per account/scope/tab.
export function subscribeRealtime(user: SessionUser, projectId: string | undefined, receive: Subscriber) {
  const key = JSON.stringify([user.uid, projectId ?? null]);
  let connection = connections.get(key);
  if (!connection) {
    const subscribers = new Set<Subscriber>();
    let closed = false, terminal = false, attempts = 0, controller: AbortController | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined, notify: ReturnType<typeof setTimeout> | undefined;
    let lastNotify = 0;
    const dirty = new Set<RealtimeTopic>();
    const sameAccount = () => session.currentUid() === user.uid;
    const emit = (topics: RealtimeTopic[]) => {
      for (const topic of topics) dirty.add(topic);
      if (notify) return;
      // Coalesce a busy project without turning each writer commit into an API read.
      notify = setTimeout(() => {
        notify = undefined;
        if (closed || !sameAccount()) return;
        const changed = [...dirty]; dirty.clear(); lastNotify = Date.now();
        for (const subscriber of subscribers) subscriber(changed);
      }, Math.max(0, 5000 - (Date.now() - lastNotify)));
    };
    const run = async () => {
      if (closed || terminal || document.visibilityState === 'hidden' || !sameAccount()) return;
      const own = new AbortController(); controller = own;
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      let retryAfter = 0;
      const alive = () => !closed && !own.signal.aborted && sameAccount();
      const touch = () => { clearTimeout(watchdog); watchdog = setTimeout(() => own.abort(), 30000); };
      touch();
      try {
        const token = await user.getIdToken();
        if (!alive()) return;
        const response = await fetch('/api/realtime' + (projectId ? '?project_id=' + encodeURIComponent(projectId) + '&topics=conversations,agents,needs-you,teams,hosting' : ''), {
          headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' }, signal: own.signal,
        });
        if ([401, 403, 404].includes(response.status)) { terminal = true; emit(projectId ? ['conversations', 'agents', 'needs-you', 'teams', 'hosting'] : ['needs-you']); return; }
        if (response.status === 429) {
          const value = response.headers.get('retry-after'), seconds = Number(value);
          const delay = value && !Number.isFinite(seconds) ? Date.parse(value) - Date.now() : seconds * 1000;
          retryAfter = Number.isFinite(delay) && delay > 0 ? Math.min(delay, 300000) : 60000;
        }
        if (!response.ok || !response.body || !response.headers.get('content-type')?.startsWith('text/event-stream')) throw Error('Updates unavailable.');
        const reader = response.body.getReader(), decoder = new TextDecoder(), parse = realtimeParser(topics => { if (alive()) { attempts = 0; emit(topics); } });
        try {
          while (alive()) { const chunk = await reader.read(); if (chunk.done) break; touch(); parse(decoder.decode(chunk.value, { stream: true })); }
        } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      } catch { /* Existing reads surface data/access errors; reconnect is independent. */ }
      finally {
        clearTimeout(watchdog);
        if (controller === own) controller = undefined;
        if (!closed && !terminal && String(document.visibilityState) !== 'hidden' && sameAccount()) {
          const delay = Math.min(30000, 1000 * 2 ** Math.min(attempts++, 5)) * (0.8 + Math.random() * 0.4);
          retry = setTimeout(() => { retry = undefined; void run(); }, Math.max(retryAfter, delay));
        }
      }
    };
    const visibility = () => {
      clearTimeout(retry); retry = undefined;
      if (document.visibilityState === 'hidden') controller?.abort();
      else if (!controller && !terminal) void run();
    };
    document.addEventListener('visibilitychange', visibility);
    connection = { subscribers, close() { closed = true; clearTimeout(retry); clearTimeout(notify); controller?.abort(); document.removeEventListener('visibilitychange', visibility); } };
    connections.set(key, connection);
    void run();
  }
  connection.subscribers.add(receive);
  const own = connection;
  return () => { own.subscribers.delete(receive); if (!own.subscribers.size) { own.close(); connections.delete(key); } };
}

export function useRealtimeTick(user: SessionUser | null, projectId: string | undefined, topic: RealtimeTopic, active: boolean) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!user || !active) return;
    return subscribeRealtime(user, projectId, topics => { if (topics.includes(topic)) setTick(value => value + 1); });
  }, [user, projectId, topic, active]);
  return tick;
}
