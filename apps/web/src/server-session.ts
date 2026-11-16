// The local owner's session on the Minions engine. The local app has one person and no sign-in step
// (owner decision, 10 November 2026): this page asks its own engine for the owner's session. The contract:
//   POST /api/auth/local-owner/session  { } → { token }; only this engine's own page on this computer gets one
//   GET  /api/auth/session              Bearer → { subject, email, displayName }; 401 once expired
// The token is kept in this browser's local storage and is never put in a URL.
import { ApiError } from './authorized-request';
import type { SessionClient, SessionUser } from './session-identity';

export const SESSION_STORAGE_KEY = 'minions.session';
// The single owner's signed `lo1.<payload>.<HMAC-SHA256>` session, or an opaque engine session (the test engine's people).
const TOKEN = /^(?:[A-Za-z0-9_-]{20,512}|lo1\.[A-Za-z0-9_-]{1,512}\.[A-Za-z0-9_-]{43})$/;

type Storage = { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void };
export type ServerSessionEnvironment = {
  fetch: typeof fetch;
  storage: Storage;
  /** Another tab changed the saved session. Returns the unsubscribe function. */
  onStorage?(listener: (key: string | null) => void): () => void;
};

export function createServerSession(env: ServerSessionEnvironment): SessionClient {
  // One user object per session token: requests share in-flight reads per signed-in user object.
  let user: SessionUser | null = null, userToken: string | null = null;
  const listeners = new Set<(user: SessionUser | null) => void>();
  const publish = (next: { user: SessionUser; token: string } | null) => {
    if ((next?.token ?? null) === userToken) return;
    user = next?.user ?? null; userToken = next?.token ?? null;
    for (const listener of [...listeners]) listener(user);
  };

  async function verify(token: string): Promise<{ user: SessionUser; token: string } | null> {
    const response = await env.fetch('/api/auth/session', { headers: { authorization: `Bearer ${token}` } });
    if (response.status === 401) { if (env.storage.getItem(SESSION_STORAGE_KEY) === token) env.storage.removeItem(SESSION_STORAGE_KEY); return null; }
    if (!response.ok) throw new Error(`The engine could not confirm this session (${response.status}).`);
    const body = await response.json() as { subject?: unknown; email?: unknown; displayName?: unknown };
    if (typeof body.subject !== 'string' || !body.subject) throw new Error('The engine returned an invalid session.');
    const email = typeof body.email === 'string' ? body.email : null, displayName = typeof body.displayName === 'string' ? body.displayName : null;
    return { token, user: { uid: body.subject, email, displayName, getIdToken: async () => {
      if (env.storage.getItem(SESSION_STORAGE_KEY) !== token) throw new ApiError(401, 'This session ended. Reload the page.');
      return token;
    } } };
  }
  async function open(): Promise<string> {
    const response = await env.fetch('/api/auth/local-owner/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    if (!response.ok) throw new Error(`The engine did not open a session (${response.status}).`);
    const body = await response.json() as { token?: unknown };
    if (typeof body.token !== 'string' || !TOKEN.test(body.token)) throw new Error('The engine returned an invalid session.');
    env.storage.setItem(SESSION_STORAGE_KEY, body.token);
    return body.token;
  }
  // A saved session the engine still accepts is used; otherwise (none yet, expired, or from a reset engine) a new one.
  async function load(): Promise<{ user: SessionUser; token: string } | null> {
    const saved = env.storage.getItem(SESSION_STORAGE_KEY);
    if (saved && TOKEN.test(saved)) { const current = await verify(saved); if (current) return current; }
    else if (saved) env.storage.removeItem(SESSION_STORAGE_KEY);
    return verify(await open());
  }
  // An unreachable engine leaves this page view without a session; reloading tries again.
  const refresh = () => load().catch(error => { console.warn('The engine session could not be opened.', error); return null; }).then(publish);
  let ready = refresh();
  env.onStorage?.(key => { if (key === null || key === SESSION_STORAGE_KEY) ready = refresh(); });

  const subscribe = (listener: (user: SessionUser | null) => void) => {
    let active = true;
    // A new listener hears the current state once it is known.
    void ready.then(() => { if (active) { listeners.add(listener); listener(user); } });
    return () => { active = false; listeners.delete(listener); };
  };

  return { currentUser: () => user, currentUid: () => user?.uid, onUserChanged: subscribe, onTokenChanged: subscribe };
}
