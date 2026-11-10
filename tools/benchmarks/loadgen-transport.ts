// Names why a loadgen request failed before an HTTP status arrived, so a local socket limit (accept queue,
// keep-alive reuse) can be told apart from a service fault. Only error codes and the request phase are kept,
// never messages, URLs or tokens.
export type TransportPhase = 'request' | 'body';
const CODE = /^[A-Za-z0-9_]{1,40}$/;
const safe = (value: unknown) => typeof value === 'string' && CODE.test(value) ? value : undefined;

// fetch wraps the socket error: TypeError('fetch failed' | 'terminated') whose cause (possibly nested once more)
// carries a code such as ECONNRESET or UND_ERR_SOCKET and, for system errors, the syscall.
export function transportCause(error: unknown, phase: TransportPhase): string {
  let found: { code?: string; syscall?: string; name?: string } = {};
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    const item = current as { code?: unknown; syscall?: unknown; name?: unknown; cause?: unknown };
    const code = safe(item.code);
    if (code) { found = { code, syscall: safe(item.syscall) }; if (found.syscall || !item.cause) break; }
    else if (!found.code) found.name = safe(item.name) ?? found.name;
    current = item.cause;
  }
  const label = found.code ? `${found.code}${found.syscall ? `/${found.syscall}` : ''}` : found.name ?? 'unknown';
  return `${phase}:${label}`;
}

export function createTransportCauses() {
  const counts = new Map<string, number>();
  return {
    record(op: string, cause: string) { const key = `${op} ${cause}`; counts.set(key, (counts.get(key) ?? 0) + 1); },
    summary(): Record<string, number> { return Object.fromEntries([...counts].sort(([a], [b]) => a.localeCompare(b))); },
  };
}
