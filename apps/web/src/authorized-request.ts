import type { SessionUser } from './session-identity';

// A capacity limit the server refused on; retrying the same request will not help.
export type LimitReached = { scope: 'agents_per_participant' | 'private_participants'; limit: number; used: number };
export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string, public limit?: LimitReached, public retryAfterMs?: number) { super(message); }
}

// In-flight reads only: no completed authenticated response is cached or persisted.
// Project viewer reads share one per-person, per-project server budget, so after a refusal every
// poller for that project waits for the same retry time instead of sending more refused requests.
const coalescedReads = new WeakMap<SessionUser, Map<string, { until: number; pending: Map<string, Promise<unknown>> }>>();
// Tabs of one person share the server budget, so a refusal seen in one tab also holds that project's reads
// in the others. Only the account id, read base and retry time cross tabs, never a response.
const heldElsewhere = new Map<string, number>();
const MAX_HOLD_MS = 300_000;
const tabs = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('minions-read-holds');
(tabs as { unref?: () => void } | null)?.unref?.();
tabs?.addEventListener('message', event => {
  const { uid, base, until } = (event as MessageEvent).data ?? {};
  if (typeof uid !== 'string' || typeof base !== 'string' || typeof until !== 'number' || !Number.isFinite(until)) return;
  const key = JSON.stringify([uid, base]);
  heldElsewhere.set(key, Math.max(heldElsewhere.get(key) ?? 0, Math.min(until, Date.now() + MAX_HOLD_MS)));
});
function retryDelay(value: string | null) {
  const seconds = value === null ? NaN : Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : value ? Date.parse(value) - Date.now() : NaN;
  return Number.isFinite(ms) && ms > 0 ? Math.min(300_000, ms) : 60_000;
}

export async function authorizedRequest<T>(user: SessionUser, base: string, path: string, body?: object, ownProfileId?: string, currentUid?: () => string | undefined, signal?: AbortSignal): Promise<T> {
  const coalescedRead = body === undefined && (base.endsWith('/api/projects') || base.endsWith('/api/view'));
  const checkAccount = () => { if ((ownProfileId || currentUid) && currentUid?.() !== user.uid) throw new ApiError(401, 'Your signed-in account changed.'); };
  checkAccount();
  if (coalescedRead) {
    let scopes = coalescedReads.get(user);
    if (!scopes) { scopes = new Map(); coalescedReads.set(user, scopes); }
    let state = scopes.get(base);
    if (!state) { state = { until: 0, pending: new Map() }; scopes.set(base, state); }
    const held = JSON.stringify([user.uid, base]);
    state.until = Math.max(state.until, heldElsewhere.get(held) ?? 0);
    heldElsewhere.delete(held);
    if (state.until > Date.now()) throw new ApiError(429, 'Updates will resume shortly. Please wait a moment.', 'rate_limited', undefined, state.until - Date.now());
    const key = JSON.stringify([base, path, ownProfileId ?? null]);
    let pending = state.pending.get(key);
    if (!pending) {
      pending = send<T>(user, base, path, undefined, ownProfileId, checkAccount, signal).catch(error => {
        if (error instanceof ApiError && error.status === 429) {
          state.until = Math.max(state.until, Date.now() + (error.retryAfterMs ?? 60_000));
          tabs?.postMessage({ uid: user.uid, base, until: state.until });
        }
        throw error;
      }).finally(() => state.pending.delete(key));
      state.pending.set(key, pending);
    }
    const value = await pending; checkAccount(); return value as T;
  }
  return send<T>(user, base, path, body, ownProfileId, checkAccount, signal);
}

async function send<T>(user: SessionUser, base: string, path: string, body: object | undefined, ownProfileId: string | undefined, checkAccount: () => void, signal?: AbortSignal): Promise<T> {
  const token = await user.getIdToken();
  checkAccount();
  let res: Response;
  const timeout = AbortSignal.timeout(body === undefined ? 15_000 : 30_000);
  // A write that times out may still have been applied. Answer like a 5xx, which screens treat as unconfirmed;
  // writes with a client_request_id can safely be sent again (owner selection, 30 October 2026).
  const unconfirmed = () => new ApiError(504, 'Minions didn’t confirm this change in time. It may still have been saved. Check, then try the same change again.', 'not_confirmed');
  try {
    res = await fetch(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${token}`, ...(ownProfileId ? { 'X-Minions-Profile-Id': ownProfileId } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal ?? timeout,
    });
  } catch (error) {
    if (body !== undefined && !signal && (timeout.aborted || error instanceof DOMException && error.name === 'TimeoutError')) throw unconfirmed();
    throw error;
  }
  // The timeout also covers the reply body: an answer cut off is a failure, not an empty success, and a write's is unconfirmed.
  const data = await res.json().catch(error => {
    if (!(signal ?? timeout).aborted) return null;
    throw body !== undefined && !signal ? unconfirmed() : error;
  });
  checkAccount();
  if (!res.ok) {
    const retryAfterMs = res.status === 429 ? retryDelay(res.headers.get('retry-after')) : undefined;
    throw new ApiError(res.status, data?.message ?? `The service answered ${res.status}.`, data?.error, data?.limit, retryAfterMs);
  }
  return data as T;
}
