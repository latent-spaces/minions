import type { Response } from 'express';

export type RealtimeTopic = 'conversations' | 'agents' | 'needs-you' | 'teams';
export type RealtimeWatch = (topic: RealtimeTopic, changed: () => void, failed: () => void) => () => void;

// Events are invalidations, never records or delivery receipts. A fresh connection
// invalidates all subscribed topics, so reconnects need no durable event cursor.
export function openRealtimeStream(res: Response, topics: RealtimeTopic[], authorize: () => Promise<void>, watch: RealtimeWatch,
  options = { batchMs: 1000, heartbeatMs: 15000, lifetimeMs: 55000 }) {
  let closed = false, checking = false, batch: ReturnType<typeof setTimeout> | undefined;
  const dirty = new Set(topics), stops: (() => void)[] = [];
  const close = () => {
    if (closed) return;
    closed = true; clearTimeout(batch); clearTimeout(lifetime); clearInterval(heartbeat);
    for (const stop of stops) stop();
    res.off('close', close); res.end();
  };
  const flush = async () => {
    batch = undefined;
    if (closed || checking || !dirty.size) return;
    checking = true;
    const changed = [...dirty]; dirty.clear();
    try {
      await authorize();
      if (!closed && !res.write(`data: ${JSON.stringify({ topics: changed })}\n\n`)) close();
    } catch { close(); }
    finally { checking = false; if (!closed && dirty.size) schedule(); }
  };
  const schedule = () => { if (!closed && !batch) batch = setTimeout(() => void flush(), options.batchMs); };
  const heartbeat = setInterval(() => { if (!closed && !res.write(': heartbeat\n\n')) close(); }, options.heartbeatMs);
  // Below Firebase Hosting's 60 s request timeout. Renewed requests reauthenticate;
  // Firestore watches linger across renewal on the same replica.
  const lifetime = setTimeout(close, options.lifetimeMs);
  res.on('close', close);
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'private, no-store, no-transform', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  try {
    for (const topic of topics) {
      const stop = watch(topic, () => { dirty.add(topic); schedule(); }, close);
      if (closed) stop(); else stops.push(stop);
      if (closed) break;
    }
    schedule();
  } catch { close(); }
  return close;
}
