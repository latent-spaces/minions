// At most one authorization batch is in flight. Pending records are coalesced by
// key and bounded independently of the SDK's snapshot rate. Overflow disconnects
// the subscriber; reconnect performs a full authorized refresh.
export function boundedRealtimeChecks<T>(key: (item: T) => string, check: (items: T[]) => Promise<boolean>,
  notify: () => void, fail: (error: unknown) => void, maximum = 84) {
  const pending = new Map<string, T>();
  let running = false, closed = false;
  const close = () => { closed = true; pending.clear(); };
  const drain = async () => {
    if (running || closed) return;
    running = true;
    try {
      while (!closed && pending.size) {
        const batch = [...pending.values()]; pending.clear();
        if (await check(batch) && !closed) notify();
      }
    } catch (error) { if (!closed) { close(); fail(error); } }
    finally { running = false; }
  };
  return { close, add(items: T[]) {
    if (closed) return;
    for (const item of items) {
      pending.set(key(item), item);
      if (pending.size > maximum) { close(); fail(new Error('Realtime authorization queue is full.')); return; }
    }
    void drain();
  } };
}
