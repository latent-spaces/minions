// Self-hosted GitHub OAuth and session routes over loopback HTTP, with GitHub replaced by a synthetic transport.
import { once } from 'node:events';
import type { Server } from 'node:http';
import { createHash } from 'node:crypto';
import express from 'express';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({ issue: vi.fn(), end: vi.fn(), profile: vi.fn(), update: vi.fn() }));
vi.mock('../src/identity/server-sessions.js', () => ({ issueGithubSession: state.issue, endSession: state.end }));
vi.mock('../src/auth.js', () => ({ profileForEmails: state.profile }));
vi.mock('../src/firestore.js', () => ({ githubAccounts: { doc: () => ({ set: vi.fn() }) }, profiles: { doc: () => ({ update: state.update }) } }));
vi.mock('../src/projects/github-username.js', async () => ({ GITHUB_USERNAME: (await import('zod')).z.string() }));
const { githubOAuthRoutes, publicOrigin, readGithubOAuthConfig } = await import('../src/github/oauth.js');
const { githubApiTransport } = await import('../src/github/sign-in.js');
const { sessionRoutes } = await import('../src/identity/session-routes.js');

const CLIENT_STATE = 'c'.repeat(32);
const config = { clientId: 'Iv1.synthetic', clientSecret: 's'.repeat(40), origin: 'https://engine.example.test' };
const session = { subject: 'github-42', signInProvider: 'github.com', authTime: 1, name: 'Ada', email: 'ada@example.test', emailVerified: true, githubId: '42' };
const provider = { verifySession: vi.fn(async (token: string) => token === 'good-token' ? session : null), account: vi.fn(), exportAccount: vi.fn() };
let server: Server, base: string;
// Each sign-in attempt starts in a fresh rate-limit window.
let clock = 1_000;
const github = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(githubApiTransport, 'fetch').mockImplementation((url, init) => github(url, init));
  github.mockImplementation(async url => {
    if (url === 'https://github.com/login/oauth/access_token') return Response.json({ access_token: 'gho_synthetic' });
    if (url.endsWith('/user')) return Response.json({ id: 42, login: 'ada', name: 'Ada', avatar_url: null });
    if (url.endsWith('/user/emails')) return Response.json([{ email: 'Ada@Example.test', verified: true, primary: true }, { email: 'x@example.test', verified: false, primary: false }]);
    throw new Error(`unexpected ${url}`);
  });
  state.issue.mockResolvedValue({ token: 'issued-token', expiresAt: 0 });
  state.end.mockResolvedValue(undefined);
  state.profile.mockResolvedValue({ id: 'p1', githubUsername: 'old' });
  const app = express();
  app.use('/api/auth', githubOAuthRoutes(config, () => clock), sessionRoutes(() => provider, state.end));
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => { vi.restoreAllMocks(); server.close(); await once(server, 'close'); });

async function start(query = '') {
  clock += 60_001;
  const separator = query ? '&' : '?';
  const response = await fetch(`${base}/api/auth/github/start${query}${separator}client_state=${CLIENT_STATE}`, { redirect: 'manual' });
  const cookie = response.headers.get('set-cookie')!;
  return { response, cookie: cookie.split(';')[0], stateValue: new URL(response.headers.get('location')!).searchParams.get('state')! };
}
const callback = (query: string, cookie?: string) =>
  fetch(`${base}/api/auth/github/callback?${query}`, { redirect: 'manual', headers: cookie ? { cookie } : {} });

test('start redirects to GitHub with a single-use state bound to an HttpOnly cookie', async () => {
  const { response, cookie, stateValue } = await start();
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get('location')!);
  expect(location.origin + location.pathname).toBe('https://github.com/login/oauth/authorize');
  expect(Object.fromEntries(location.searchParams)).toMatchObject({ client_id: 'Iv1.synthetic', redirect_uri: 'https://engine.example.test/api/auth/github/callback', scope: 'read:user user:email' });
  expect(stateValue).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(location.searchParams.get('code_challenge_method')).toBe('S256');
  expect(location.searchParams.has('prompt')).toBe(false);
  // The cookie holds the state plus a PKCE verifier that GitHub only ever sees hashed.
  const [cookieState, verifier, clientState] = cookie.slice('mlswarm_github_state='.length).split('.');
  expect(clientState).toBe(CLIENT_STATE);
  expect(cookieState).toBe(stateValue);
  expect(location.searchParams.get('code_challenge')).toBe(createHash('sha256').update(verifier).digest('base64url'));
  expect(location.toString()).not.toContain(verifier);
  expect(response.headers.get('set-cookie')).toMatch(/HttpOnly; SameSite=Lax; Max-Age=600; Secure$/);
  expect(response.headers.get('cache-control')).toBe('no-store');
});

test('a confirmed GitHub account gets a session in the URL fragment and keeps its username current', async () => {
  const { cookie, stateValue } = await start();
  const response = await callback(`code=synthetic-code&state=${stateValue}`, cookie);
  expect(response.status).toBe(303);
  expect(response.headers.get('location')).toBe('https://engine.example.test/viewer/#mlswarm_session=issued-token&mlswarm_state=' + CLIENT_STATE);
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  expect(response.headers.get('set-cookie')).toMatch(/^mlswarm_github_state=; .*Max-Age=0/);
  expect(state.issue).toHaveBeenCalledWith({ githubId: '42', login: 'ada', name: 'Ada', avatarUrl: null, emails: ['ada@example.test'] }, expect.any(Function));
  expect(state.update).toHaveBeenCalledWith({ githubUsername: 'ada' });
  // The code exchange carries the client secret only to GitHub, with the registered callback.
  const exchange = github.mock.calls.find(([url]) => url.includes('access_token'))!;
  const verifier = cookie.slice('mlswarm_github_state='.length).split('.')[1];
  expect(Object.fromEntries(new URLSearchParams(exchange[1].body as string))).toEqual({ client_id: 'Iv1.synthetic', client_secret: config.clientSecret,
    code: 'synthetic-code', redirect_uri: 'https://engine.example.test/api/auth/github/callback', code_verifier: verifier });
});

test.each([
  ['no cookie', (s: string) => [`code=c&state=${s}`, undefined]],
  ['a different state', (_s: string, c: string) => [`code=c&state=${'A'.repeat(43)}`, c]],
  ['no code (GitHub denied)', (s: string, c: string) => [`error=access_denied&state=${s}`, c]],
  ['a cookie without its verifier', (s: string) => [`code=c&state=${s}`, `mlswarm_github_state=${s}`]],
] as const)('a callback with %s never reaches GitHub or issues a session', async (_name, input) => {
  const { stateValue, cookie: started } = await start();
  github.mockClear();
  const [query, cookie] = input(stateValue, started);
  const response = await callback(query!, cookie);
  expect(response.headers.get('location')).toMatch(/^https:\/\/engine\.example\.test\/viewer\/#mlswarm_sign_in_error=retry(&mlswarm_state=c{32})?$/);
  expect(response.headers.get('location')).not.toContain('mlswarm_session');
  expect(github).not.toHaveBeenCalled();
  expect(state.issue).not.toHaveBeenCalled();
});

test('a code GitHub refuses, or an account without a verified email, is refused without a session', async () => {
  github.mockImplementationOnce(async () => Response.json({ error: 'bad_verification_code' }));
  let { cookie, stateValue } = await start();
  expect((await callback(`code=c&state=${stateValue}`, cookie)).headers.get('location')).toBe('https://engine.example.test/viewer/#mlswarm_sign_in_error=refused&mlswarm_state=' + CLIENT_STATE);
  github.mockImplementation(async url => url.includes('access_token') ? Response.json({ access_token: 't' })
    : url.endsWith('/user') ? Response.json({ id: 42, login: 'ada' }) : Response.json([{ email: 'a@example.test', verified: false, primary: true }]));
  ({ cookie, stateValue } = await start());
  expect((await callback(`code=c&state=${stateValue}`, cookie)).headers.get('location')).toBe('https://engine.example.test/viewer/#mlswarm_sign_in_error=refused&mlswarm_state=' + CLIENT_STATE);
  expect(state.issue).not.toHaveBeenCalled();
});

test('a GitHub outage is reported as temporary, not as a refusal', async () => {
  github.mockImplementation(async () => new Response('', { status: 503 }));
  const { cookie, stateValue } = await start();
  expect((await callback(`code=c&state=${stateValue}`, cookie)).headers.get('location')).toBe('https://engine.example.test/viewer/#mlswarm_sign_in_error=unavailable&mlswarm_state=' + CLIENT_STATE);
  expect(state.issue).not.toHaveBeenCalled();
});

test('the session endpoint describes a valid bearer token and refuses others', async () => {
  const ok = await fetch(`${base}/api/auth/session`, { headers: { authorization: 'Bearer good-token' } });
  expect(await ok.json()).toEqual({ subject: 'github-42', email: 'ada@example.test', displayName: 'Ada' });
  expect((await fetch(`${base}/api/auth/session`, { headers: { authorization: 'Bearer stale' } })).status).toBe(401);
  expect((await fetch(`${base}/api/auth/session`)).status).toBe(401);
});

test('sign-out ends the presented session', async () => {
  const response = await fetch(`${base}/api/auth/session/revoke`, { method: 'POST', headers: { authorization: 'Bearer good-token' } });
  expect(response.status).toBe(204);
  expect(state.end).toHaveBeenCalledWith('good-token');
});

test('settings must be complete; the origin must be https or http on 127.0.0.1, with no path', () => {
  const env = { MLSWARM_GITHUB_CLIENT_ID: 'Iv1.synthetic', MLSWARM_GITHUB_CLIENT_SECRET: 's'.repeat(40), MLSWARM_PUBLIC_ORIGIN: 'https://engine.example.test' };
  expect(readGithubOAuthConfig(env)).toEqual({ clientId: 'Iv1.synthetic', clientSecret: 's'.repeat(40), origin: 'https://engine.example.test' });
  for (const missing of Object.keys(env)) expect(() => readGithubOAuthConfig({ ...env, [missing]: undefined })).toThrow();
  expect(publicOrigin('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787');
  for (const bad of ['http://localhost:8787', 'http://engine.example.test', 'https://engine.example.test/', 'https://engine.example.test/app', 'https://u:p@engine.example.test', 'ftp://x', '', undefined])
    expect(publicOrigin(bad)).toBeNull();
});

test('a return path inside the web app and an account prompt survive the round trip; anything else falls back', async () => {
  let { response, cookie, stateValue } = await start('?return=%2Fviewer%2F%3Fproject%3Dabc&prompt=select_account');
  expect(new URL(response.headers.get('location')!).searchParams.get('prompt')).toBe('select_account');
  expect((await callback(`code=c&state=${stateValue}`, cookie)).headers.get('location')).toBe('https://engine.example.test/viewer/?project=abc#mlswarm_session=issued-token&mlswarm_state=' + CLIENT_STATE);
  for (const bad of ['https://evil.test/', '//evil.test/viewer/', '/viewer//evil.test', '/viewer/../admin', '/other/', '/viewer/\\x']) {
    ({ cookie, stateValue } = await start(`?return=${encodeURIComponent(bad)}`));
    expect((await callback(`code=c&state=${stateValue}`, cookie)).headers.get('location'), bad).toBe('https://engine.example.test/viewer/#mlswarm_session=issued-token&mlswarm_state=' + CLIENT_STATE);
  }
});

test('sign-in must start from the app with its own state, which comes back with the session', async () => {
  for (const bad of ['', '?client_state=short', `?client_state=${'c'.repeat(31)}.x`, `?client_state=${'c'.repeat(65)}`]) {
    const response = await fetch(`${base}/api/auth/github/start${bad}`, { redirect: 'manual' });
    expect(response.status, bad).toBe(400);
    expect(response.headers.get('set-cookie')).toBeNull();
  }
  const { cookie, stateValue } = await start();
  const location = new URL((await callback(`code=c&state=${stateValue}`, cookie)).headers.get('location')!);
  expect(Object.fromEntries(new URLSearchParams(location.hash.slice(1)))).toEqual({ mlswarm_session: 'issued-token', mlswarm_state: CLIENT_STATE });
});
