// Acceptance for self-hosted sign-in: the web app's actual session client (apps/web/src/server-session.ts) against the
// engine's actual GitHub OAuth and session routes, with sessions stored in the disposable Firestore emulator. Only
// GitHub is synthetic. No real OAuth app, credentials or model.
import { once } from 'node:events';
import type { Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import express from 'express';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { githubOAuthRoutes } from '../src/github/oauth.js';
import { githubApiTransport } from '../src/github/sign-in.js';
import { sessionRoutes } from '../src/identity/session-routes.js';
import { endSession, issueGithubSession, serverSessionIdentity } from '../src/identity/server-sessions.js';
import { identity, setIdentityProvider } from '../src/identity/index.js';
import { signInFromIdToken } from '../src/auth.js';
import { resetEmulator } from './helpers.js';

// The web app's sources use bundler resolution, which the server's nodenext typecheck refuses, so the actual client is
// loaded by path (Vitest compiles it) and described here only as far as this test uses it.
type SessionUser = { uid: string; email: string | null; displayName: string | null; getIdToken(): Promise<string> };
type Store = { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void };
type SessionClient = { onUserChanged(listener: (user: SessionUser | null) => void): () => void; signIn(): Promise<void>; signOut(): Promise<void> };
type WebSession = {
  SESSION_STORAGE_KEY: string; SIGN_IN_STATE_KEY: string;
  createServerSession(env: { fetch: typeof fetch; storage: Store; tabStorage: Store; nonce(): string;
    location: { pathname: string; search: string; hash: string }; replaceUrl(url: string): void; navigate(url: string): void }): SessionClient;
};
const webSession = new URL('../../web/src/server-session.ts', import.meta.url).href;
const { createServerSession, SESSION_STORAGE_KEY, SIGN_IN_STATE_KEY } = await import(webSession) as WebSession;

let server: Server, base: string, clock = 1_000_000_000_000;
const hosted = identity();
const github = { refuse: false, emails: [{ email: 'Ana@Example.test', verified: true, primary: true }, { email: 'ana@example.test', verified: true, primary: false }] };

beforeEach(async () => {
  await resetEmulator();
  github.refuse = false;
  vi.spyOn(githubApiTransport, 'fetch').mockImplementation(async url => {
    if (url === 'https://github.com/login/oauth/access_token') {
      return Response.json(github.refuse ? { error: 'bad_verification_code' } : { access_token: 'gho_synthetic' });
    }
    if (url.endsWith('/user')) return Response.json({ id: 4242, login: 'ana', name: 'Ana', avatar_url: null });
    if (url.endsWith('/user/emails')) return Response.json(github.emails);
    throw new Error(`unexpected GitHub call ${url}`);
  });
  const app = express();
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const config = { clientId: 'Iv1.synthetic', clientSecret: 's'.repeat(40), origin: base };
  setIdentityProvider(serverSessionIdentity(() => clock));
  app.use('/api/auth', githubOAuthRoutes(config, () => clock), sessionRoutes(() => identity(), endSession));
});
afterEach(async () => {
  setIdentityProvider(hosted);
  vi.restoreAllMocks();
  server.close(); await once(server, 'close');
});

const memory = () => { const data = new Map<string, string>(); return {
  getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); },
  removeItem: (key: string) => { data.delete(key); }, data } };

/** One browser tab: localStorage survives page loads, sessionStorage belongs to the tab. */
function browser(storage = memory(), tabStorage = memory()) {
  let navigated = '', current = '/viewer/projects';
  const load = (address: string) => {
    const url = new URL(address, base);
    current = `${url.pathname}${url.search}${url.hash}`;
    return createServerSession({
      fetch: (input, init) => fetch(new URL(String(input), base), init), storage, tabStorage,
      nonce: () => randomBytes(32).toString('base64url'),
      location: { pathname: url.pathname, search: url.search, hash: url.hash },
      replaceUrl: next => { current = next; }, navigate: next => { navigated = next; },
    });
  };
  return { storage, tabStorage, load, navigated: () => navigated, address: () => current };
}
const user = (client: SessionClient) =>
  new Promise<SessionUser | null>(resolve => { const stop = client.onUserChanged(value => { stop(); resolve(value); }); });

/** Follows the engine's redirect to GitHub and GitHub's redirect back; returns the engine's final redirect. */
async function throughGithub(startPath: string, { tamperState = false, dropCookie = false } = {}) {
  clock += 60_001; // a fresh rate-limit window per attempt
  const start = await fetch(new URL(startPath, base), { redirect: 'manual' });
  expect(start.status).toBe(302);
  const authorize = new URL(start.headers.get('location')!);
  expect(authorize.origin).toBe('https://github.com');
  const state = tamperState ? 'x'.repeat(43) : authorize.searchParams.get('state')!;
  const cookie = start.headers.get('set-cookie')!.split(';')[0];
  const callback = await fetch(`${base}/api/auth/github/callback?code=synthetic-code&state=${state}`,
    { redirect: 'manual', headers: dropCookie ? {} : { cookie } });
  expect(callback.status).toBe(303);
  return callback.headers.get('location')!;
}

test('a started sign-in returns a session the web app stores, the engine verifies and auth.ts accepts; sign-out revokes it', async () => {
  const tab = browser();
  const page = tab.load('/viewer/projects?view=mine');
  expect(await user(page)).toBeNull();
  void page.signIn();
  const startPath = tab.navigated();
  expect(startPath).toMatch(/^\/api\/auth\/github\/start\?client_state=[A-Za-z0-9_-]{43}&return=%2Fviewer%2Fprojects%3Fview%3Dmine$/);
  const nonce = tab.tabStorage.getItem(SIGN_IN_STATE_KEY)!;

  const returned = await throughGithub(startPath);
  const fragment = new URLSearchParams(new URL(returned).hash.slice(1));
  expect(new URL(returned).pathname + new URL(returned).search).toBe('/viewer/projects?view=mine');
  expect(fragment.get('mlswarm_state')).toBe(nonce);
  const token = fragment.get('mlswarm_session')!;

  // The returned page: the fragment leaves the address, the nonce is spent and the engine confirms the session.
  const signedIn = await user(tab.load(returned));
  expect(tab.address()).toBe('/viewer/projects?view=mine');
  expect(tab.tabStorage.getItem(SIGN_IN_STATE_KEY)).toBeNull();
  expect(tab.storage.getItem(SESSION_STORAGE_KEY)).toBe(token);
  expect(signedIn).toMatchObject({ uid: 'github-4242', email: 'ana@example.test', displayName: 'Ana' });

  // Every API route authenticates through auth.ts: the normalized verified GitHub emails reach invitation matching.
  const bearer = await signedIn!.getIdToken();
  expect(await signInFromIdToken(bearer)).toMatchObject({ firebaseUid: 'github-4242', provider: 'github.com', emails: ['ana@example.test'], githubUsername: 'ana' });

  // Sign-out ends the session on the engine as well as in the browser.
  const client = tab.load('/viewer/projects');
  await user(client);
  await client.signOut();
  expect(tab.storage.getItem(SESSION_STORAGE_KEY)).toBeNull();
  expect((await fetch(`${base}/api/auth/session`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
  await expect(signInFromIdToken(token)).rejects.toThrow('Sign in with GitHub.');
});

test('a link carrying someone else’s valid session never signs this browser in or replaces its session', async () => {
  // The attacker completes their own sign-in and keeps the token.
  const attacker = browser();
  const attackerPage = attacker.load('/viewer/');
  await user(attackerPage);
  void attackerPage.signIn();
  const attackerToken = new URLSearchParams(new URL(await throughGithub(attacker.navigated())).hash.slice(1)).get('mlswarm_session')!;
  expect((await fetch(`${base}/api/auth/session`, { headers: { authorization: `Bearer ${attackerToken}` } })).status).toBe(200);

  // The victim is signed in to their own account.
  const own = await issueGithubSession({ githubId: '777', login: 'vic', name: 'Vic', avatarUrl: null, emails: ['vic@example.test'] }, () => clock);
  // They open a crafted link, with or without a guessed state, even while a real sign-in of theirs is in flight.
  for (const hash of [`#mlswarm_session=${attackerToken}`, `#mlswarm_session=${attackerToken}&mlswarm_state=${'g'.repeat(43)}`]) {
    const victim = browser();
    victim.storage.setItem(SESSION_STORAGE_KEY, own.token);
    victim.tabStorage.setItem(SIGN_IN_STATE_KEY, 'n'.repeat(43));
    const page = victim.load(`/viewer/${hash}`);
    expect(victim.address()).toBe('/viewer/');
    expect(await user(page)).toMatchObject({ uid: 'github-777' });
    expect(victim.storage.getItem(SESSION_STORAGE_KEY)).toBe(own.token);
  }
});

test('refused, mismatched-state and cookie-less callbacks return error fragments and store nothing', async () => {
  // GitHub refuses the code: the error carries this tab's state, and the person stays signed out.
  github.refuse = true;
  const tab = browser();
  const page = tab.load('/viewer/');
  await user(page);
  void page.signIn();
  const nonce = tab.tabStorage.getItem(SIGN_IN_STATE_KEY)!;
  const refused = new URLSearchParams(new URL(await throughGithub(tab.navigated())).hash.slice(1));
  expect(Object.fromEntries(refused)).toEqual({ mlswarm_sign_in_error: 'refused', mlswarm_state: nonce });
  expect(await user(tab.load(`/viewer/#${refused}`))).toBeNull();
  expect(tab.storage.getItem(SESSION_STORAGE_KEY)).toBeNull();

  // A GitHub answer for a different OAuth state, or without the engine's cookie, is never exchanged.
  github.refuse = false;
  vi.mocked(githubApiTransport.fetch).mockClear();
  for (const options of [{ tamperState: true }, { dropCookie: true }]) {
    const retry = browser();
    const retryPage = retry.load('/viewer/');
    await user(retryPage);
    void retryPage.signIn();
    const answer = new URL(await throughGithub(retry.navigated(), options));
    expect(answer.hash).toMatch(/^#mlswarm_sign_in_error=retry/);
    expect(answer.hash).not.toContain('mlswarm_session');
    expect(await user(retry.load(answer.href))).toBeNull();
  }
  expect(githubApiTransport.fetch).not.toHaveBeenCalledWith('https://github.com/login/oauth/access_token', expect.anything());

  // A start without the web app's own state is refused before any cookie or GitHub redirect.
  const bare = await fetch(`${base}/api/auth/github/start`, { redirect: 'manual' });
  expect(bare.status).toBe(400);
  expect(bare.headers.get('set-cookie')).toBeNull();
});
