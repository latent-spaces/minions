// Sign-in through the MyLittleSwarm engine: GitHub through the engine itself, which issues an opaque session token
// (apps/server identity provider, #483). No sign-in SDK. The contract with the engine:
//   GET  /api/auth/github/start    ?client_state=<nonce>&return=<page>&prompt=select_account; full-page redirect; the engine
//                                  returns here with #mlswarm_session=<token>&mlswarm_state=<nonce>,
//                                  or #mlswarm_sign_in_error=<reason>&mlswarm_state=<nonce> when it could not finish
//   GET  /api/auth/session         Bearer → { subject, email, displayName }; 401 once expired or revoked
//   POST /api/auth/session/revoke  Bearer → ends this session on the engine
//   POST /api/auth/local-owner/exchange  { code, client_state } → { token, client_state }; a single-owner engine's launcher
//                                  links to #mlswarm_owner_code=<code>, which this page trades for a session (one use, 5 min)
// The token is kept in this browser's local storage and is never put
// in a URL the engine logs: the fragment is not sent to servers and is removed before anything else runs.
// A returned session is accepted only with the nonce this tab sent when it started the sign-in, so a crafted
// link cannot sign a person into someone else's account (login CSRF).
import { ApiError } from './authorized-request';
import type { SessionClient, SessionUser } from './session-identity';

export const SESSION_FRAGMENT = 'mlswarm_session';
export const SIGN_IN_ERROR_FRAGMENT = 'mlswarm_sign_in_error';
export const STATE_FRAGMENT = 'mlswarm_state';
export const OWNER_CODE_FRAGMENT = 'mlswarm_owner_code';
export const SESSION_STORAGE_KEY = 'mlswarm.session';
export const SIGN_IN_STATE_KEY = 'mlswarm.sign-in-state';
// An engine session is either opaque (GitHub sign-in) or the single owner's signed `lo1.<payload>.<HMAC-SHA256>`.
const TOKEN = /^(?:[A-Za-z0-9_-]{20,512}|lo1\.[A-Za-z0-9_-]{1,512}\.[A-Za-z0-9_-]{43})$/, OWNER_CODE = /^[A-Za-z0-9_-]{43}$/;

type Storage = { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void };
export type ServerSessionEnvironment = {
  fetch: typeof fetch;
  storage: Storage;
  /** This tab's storage (sessionStorage), for the nonce of a sign-in it started. */
  tabStorage: Storage;
  /** A fresh unguessable nonce. */
  nonce(): string;
  /** The current page address, read once at start for a returned session. */
  location: { hash: string; pathname: string; search: string };
  /** Replaces the current address without reloading, to drop the returned token from it. */
  replaceUrl(url: string): void;
  /** Leaves the page for the engine's GitHub sign-in. */
  navigate(url: string): void;
  /** Another tab signed in or out. Returns the unsubscribe function. */
  onStorage?(listener: (key: string | null) => void): () => void;
};

export function createServerSession(env: ServerSessionEnvironment): SessionClient {
  // A session returned by the engine replaces any saved one, and leaves the address before anything can copy it.
  const fragment = new URLSearchParams(env.location.hash.replace(/^#/, ''));
  const returned = fragment.get(SESSION_FRAGMENT), refused = fragment.get(SIGN_IN_ERROR_FRAGMENT), state = fragment.get(STATE_FRAGMENT);
  const ownerCode = fragment.get(OWNER_CODE_FRAGMENT);
  if (returned !== null || refused !== null || state !== null || ownerCode !== null) {
    for (const key of [SESSION_FRAGMENT, SIGN_IN_ERROR_FRAGMENT, STATE_FRAGMENT, OWNER_CODE_FRAGMENT]) fragment.delete(key);
    const rest = fragment.toString();
    env.replaceUrl(`${env.location.pathname}${env.location.search}${rest ? `#${rest}` : ''}`);
  }
  if (returned !== null || refused !== null || state !== null) {
    // Each started sign-in is answered once; a replayed or crafted answer finds no nonce.
    const expected = env.tabStorage.getItem(SIGN_IN_STATE_KEY);
    env.tabStorage.removeItem(SIGN_IN_STATE_KEY);
    const ours = expected !== null && state === expected;
    if (returned !== null && ours && TOKEN.test(returned)) env.storage.setItem(SESSION_STORAGE_KEY, returned);
    else if (returned !== null) console.warn('Ignored a sign-in this tab did not start.');
    // The engine could not finish the GitHub sign-in (expired state, GitHub refused); the person stays as they were.
    if (refused !== null) console.warn('Sign-in was not completed.', refused);
  }

  // One user object per session token: requests share in-flight reads per signed-in user object.
  let user: SessionUser | null = null, userToken: string | null = null;
  const listeners = new Set<(user: SessionUser | null) => void>();
  const publish = (next: { user: SessionUser; token: string } | null) => {
    if ((next?.token ?? null) === userToken) return;
    user = next?.user ?? null; userToken = next?.token ?? null;
    for (const listener of [...listeners]) listener(user);
  };

  async function load(): Promise<{ user: SessionUser; token: string } | null> {
    const token = env.storage.getItem(SESSION_STORAGE_KEY);
    if (!token || !TOKEN.test(token)) { env.storage.removeItem(SESSION_STORAGE_KEY); return null; }
    const response = await env.fetch('/api/auth/session', { headers: { authorization: `Bearer ${token}` } });
    if (response.status === 401) { if (env.storage.getItem(SESSION_STORAGE_KEY) === token) env.storage.removeItem(SESSION_STORAGE_KEY); return null; }
    if (!response.ok) throw new Error(`The engine could not confirm this sign-in (${response.status}).`);
    const body = await response.json() as { subject?: unknown; email?: unknown; displayName?: unknown };
    if (typeof body.subject !== 'string' || !body.subject) throw new Error('The engine returned an invalid session.');
    const email = typeof body.email === 'string' ? body.email : null, displayName = typeof body.displayName === 'string' ? body.displayName : null;
    return { token, user: { uid: body.subject, email, displayName, getIdToken: async () => {
      if (env.storage.getItem(SESSION_STORAGE_KEY) !== token) throw new ApiError(401, 'This session ended. Sign in again.');
      return token;
    } } };
  }
  // A single-owner engine's launcher hands over a one-time code instead of a session, so this page binds the exchange
  // to its own state like any other sign-in it starts. A link never replaces a session the engine still accepts.
  async function exchangeOwnerCode(code: string): Promise<void> {
    // A saved session the engine still accepts wins. One it no longer accepts (expired, revoked, or from before the
    // engine was reset) is forgotten by load(), so the owner's fresh link can sign them back in.
    if (env.storage.getItem(SESSION_STORAGE_KEY) && await load()) { console.warn('Already signed in; the owner link was not used.'); return; }
    if (!OWNER_CODE.test(code)) { console.warn('Ignored a malformed owner link.'); return; }
    const clientState = env.nonce();
    const request = () => env.fetch('/api/auth/local-owner/exchange', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, client_state: clientState }) });
    // The engine answers the same code and state with the same session, so one lost response is retried as is.
    const response = await request().catch(() => request());
    if (!response.ok) { console.warn(`The owner link was refused (${response.status}). Ask the engine for a new one.`); return; }
    const body = await response.json() as { token?: unknown; client_state?: unknown };
    if (body.client_state !== clientState || typeof body.token !== 'string' || !TOKEN.test(body.token)) {
      console.warn('Ignored an owner sign-in this page did not ask for.'); return;
    }
    if (!env.storage.getItem(SESSION_STORAGE_KEY)) env.storage.setItem(SESSION_STORAGE_KEY, body.token);
  }
  // An unreachable engine leaves the person signed out for this page view but keeps the session for the next one.
  const refresh = () => load().catch(error => { console.warn('Sign-in could not be checked.', error); return null; }).then(publish);
  let ready = ownerCode === null ? refresh()
    : exchangeOwnerCode(ownerCode).catch(error => console.warn('The owner link could not be used.', error)).then(refresh);
  env.onStorage?.(key => { if (key === null || key === SESSION_STORAGE_KEY) ready = refresh(); });

  const subscribe = (listener: (user: SessionUser | null) => void) => {
    let active = true;
    // A new listener hears the current state once it is known.
    void ready.then(() => { if (active) { listeners.add(listener); listener(user); } });
    return () => { active = false; listeners.delete(listener); };
  };

  return {
    currentUser: () => user,
    currentUid: () => user?.uid,
    onUserChanged: subscribe,
    onTokenChanged: subscribe,
    async signIn(options = {}) {
      // The engine returns to this page (it accepts only paths inside the web app) and can offer another GitHub account.
      const clientState = env.nonce();
      env.tabStorage.setItem(SIGN_IN_STATE_KEY, clientState);
      const start = new URLSearchParams({ client_state: clientState, return: `${env.location.pathname}${env.location.search}` });
      if (options.chooseAccount) start.set('prompt', 'select_account');
      env.navigate(`/api/auth/github/start?${start}`);
      // The page is leaving; the engine returns to it with the session.
      await new Promise<never>(() => {});
    },
    async signOut() {
      const token = env.storage.getItem(SESSION_STORAGE_KEY);
      env.storage.removeItem(SESSION_STORAGE_KEY);
      publish(null);
      if (token) await env.fetch('/api/auth/session/revoke', { method: 'POST', headers: { authorization: `Bearer ${token}` } })
        .catch(error => console.warn('The engine could not end this session; it expires on its own.', error));
    },
  };
}
