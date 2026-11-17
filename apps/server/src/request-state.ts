// Small process-local guards. Durable authorization and mutation fences never use this state.
type Window = { calls: number[]; touchedAt: number; namespace: string };
const MAX_WINDOW_MS = 60_000;

export class WindowLimitStore {
  private readonly entries = new Map<string, Window>();
  private readonly perNamespace = new Map<string, number>();
  // One namespace (e.g. a signed-out route keyed by client address) cannot take the capacity that
  // other routes need to admit new identities.
  private readonly maxNamespaceKeys: number;
  constructor(private readonly maxKeys = 20_000, namespaceShare = 0.25) {
    if (!Number.isInteger(maxKeys) || maxKeys < 1) throw new Error('Invalid request-state capacity.');
    if (!(namespaceShare > 0 && namespaceShare <= 1)) throw new Error('Invalid request-state namespace share.');
    this.maxNamespaceKeys = Math.max(1, Math.floor(maxKeys * namespaceShare));
  }
  // New identities refused because a bound was full. Overload evidence, not a per-identity rate limit.
  private refused = 0;
  get size() { return this.entries.size; }
  // Process-local capacity observation for diagnostics and capacity tests; never an admission input.
  stats() {
    let largestNamespaceKeys = 0;
    for (const count of this.perNamespace.values()) largestNamespaceKeys = Math.max(largestNamespaceKeys, count);
    return { keys: this.entries.size, maxKeys: this.maxKeys, namespaces: this.perNamespace.size,
      largestNamespaceKeys, maxNamespaceKeys: this.maxNamespaceKeys, refusedNewKeys: this.refused };
  }
  private remove(id: string, entry: Window) {
    this.entries.delete(id);
    const left = (this.perNamespace.get(entry.namespace) ?? 1) - 1;
    if (left > 0) this.perNamespace.set(entry.namespace, left); else this.perNamespace.delete(entry.namespace);
  }
  limiter(namespace: () => string, max: number, windowMs: number) {
    if (!Number.isInteger(max) || max < 1 || max > 120 || windowMs <= 0 || windowMs > MAX_WINDOW_MS) throw new Error('Invalid API window.');
    return (key: string, at: number): number => {
      // Access order lets cleanup stop at a recent entry; cap cleanup work per request.
      let swept = 0;
      for (const [id, entry] of this.entries) {
        if (swept++ >= 128 || at - entry.touchedAt < MAX_WINDOW_MS) break;
        this.remove(id, entry);
      }
      const name = namespace(), id = JSON.stringify([name, key]);
      const previous = this.entries.get(id);
      if (!previous && (this.entries.size >= this.maxKeys || (this.perNamespace.get(name) ?? 0) >= this.maxNamespaceKeys)) {
        // Never evict an active quota to admit a new identity: that would bypass its limit.
        this.refused++;
        return MAX_WINDOW_MS;
      }
      if (!previous) this.perNamespace.set(name, (this.perNamespace.get(name) ?? 0) + 1);
      const recent = (previous?.calls ?? []).filter(t => at - t < windowMs);
      const retry = recent.length >= max ? recent[0] + windowMs - at : 0;
      if (retry === 0) recent.push(at);
      this.entries.delete(id);
      this.entries.set(id, { calls: recent, touchedAt: at, namespace: name });
      return retry;
    };
  }
}

// One bound across projects/endpoints, rather than an independent unbounded map per router.
// This is overload protection for one process, not a fleet-wide rate-limit guarantee.
export const requestLimits = new WindowLimitStore();
// Terminal contact cannot lose its first allocation to ordinary traffic filling the shared store.
// Its namespaces are per project and already separate from ordinary traffic, so its capacity is unchanged.
export const terminalRequestLimits = new WindowLimitStore(5000, 1);

// Least-recently-used process-local values. A hit refreshes order, so a busy entry is not evicted
// merely because many others were created after it. Holds optimizations only, never authority.
export class RecentlyUsed<T> {
  private readonly entries = new Map<string, T>();
  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('Invalid cache capacity.');
  }
  get size() { return this.entries.size; }
  get(key: string, create: () => T): T {
    const found = this.entries.get(key);
    if (found !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, found);
      return found;
    }
    if (this.entries.size >= this.capacity) this.entries.delete(this.entries.keys().next().value!);
    const made = create();
    this.entries.set(key, made);
    return made;
  }
}

// Coalesce cold/expired reads, including a synchronized reconnect. Failed reads are retryable;
// expired data is never silently returned as current. TTL starts when generation begins.
export function sharedRead<T>(read: () => Promise<T>, now: () => number, ttlMs: number): () => Promise<T> {
  let cached: { at: number; value: T } | undefined;
  let pending: Promise<T> | undefined;
  return () => {
    const at = now();
    if (cached && at >= cached.at && at - cached.at < ttlMs) return Promise.resolve(cached.value);
    if (!pending) {
      pending = Promise.resolve().then(read).then(value => { cached = { at, value }; return value; })
        .finally(() => { pending = undefined; });
    }
    return pending;
  };
}
