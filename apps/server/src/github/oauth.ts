// Self-hosted GitHub sign-in without Firebase: the engine runs GitHub's OAuth web flow itself, confirms the account
// and its verified emails through the same GitHub calls as the hosted sign-in, and issues its own session
// (identity/server-sessions.ts). The session token reaches the web app only in a URL fragment, which browsers
// never send to a server or put in a Referer.
import express from 'express';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { Refusal } from '../errors.js';
import { issueGithubSession } from '../identity/server-sessions.js';
import { requestLimits } from '../request-state.js';
import { confirmGithubAccount, followGithubUsername, githubApiTransport, unverified } from './sign-in.js';

import { type GithubOAuthConfig } from './oauth-config.js';
export type { GithubOAuthConfig } from './oauth-config.js';
export { publicOrigin, readGithubOAuthConfig } from './oauth-config.js';
const STATE_COOKIE = 'mlswarm_github_state';
const STATE_TTL_SECONDS = 600;
const STATE = /^[A-Za-z0-9_-]{43}$/;
// Where the web app lives (apps/web vite base). A return path must stay inside it.
const WEB_BASE = '/viewer/';
const returnPath = (value: unknown) => typeof value === 'string' && value.length <= 512 && value.startsWith(WEB_BASE)
  && /^[A-Za-z0-9/_.~%=&?:@!$'()*+,;-]*$/.test(value) && !value.includes('//') && !value.includes('..') ? value : WEB_BASE;

const callbackUrl = (config: GithubOAuthConfig) => `${config.origin}/api/auth/github/callback`;

const cookieOf = (header: string | undefined, name: string) => {
  for (const part of (header ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return undefined;
};
const sameState = (a: string, b: string) => STATE.test(a) && STATE.test(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// The web app's own random state for this sign-in. It comes back next to the session token, so the app accepts only a
// session it asked for and a crafted link cannot sign someone into another account (login CSRF).
const CLIENT_STATE = /^[A-Za-z0-9_-]{22,64}$/;

// The cookie carries the OAuth state, the PKCE verifier, the web app's state and the return path. GitHub sees only the OAuth state.
type Pending = { state: string; verifier: string; clientState: string; back: string };
const encodePending = (pending: Pending) =>
  [pending.state, pending.verifier, pending.clientState, Buffer.from(pending.back).toString('base64url')].join('.');
function decodePending(value: string | undefined): Pending | null {
  const [state = '', verifier = '', clientState = '', back = '', extra] = (value ?? '').split('.');
  if (extra !== undefined || !STATE.test(state) || !STATE.test(verifier) || !CLIENT_STATE.test(clientState) || !/^[A-Za-z0-9_-]{1,700}$/.test(back)) return null;
  return { state, verifier, clientState, back: returnPath(Buffer.from(back, 'base64url').toString('utf8')) };
}

const TOKEN_RESPONSE = z.object({ access_token: z.string().min(1).max(512) });

/** Exchanges the one-time code for a GitHub access token. A refusal means the code was wrong, used or expired. */
async function exchangeCode(config: GithubOAuthConfig, code: string, verifier: string): Promise<string> {
  const response = await githubApiTransport.fetch('https://github.com/login/oauth/access_token', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'mlswarm' },
    body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, code, redirect_uri: callbackUrl(config), code_verifier: verifier }).toString(),
  }).catch(() => { throw new Error('GitHub sign-in is temporarily unavailable.'); });
  if (response.status === 429 || response.status >= 500) {
    await response.body?.cancel().catch(() => {});
    throw new Error('GitHub sign-in is temporarily unavailable.');
  }
  // GitHub answers a bad code with 200 and an `error` field instead of a token.
  const body = TOKEN_RESPONSE.safeParse(await response.json().catch(() => null));
  if (!response.ok || !body.success) throw new Refusal('unauthorized', 'GitHub didn’t confirm this sign-in. Sign in again.');
  return body.data.access_token;
}

/** Mount at /api/auth only on a self-hosted engine, next to sessionRoutes; the hosted service signs in through Firebase. */
export function githubOAuthRoutes(config: GithubOAuthConfig, now: () => number) {
  const router = express.Router();
  const limit = requestLimits.limiter(() => 'github-oauth', 30, 60_000);
  const secure = config.origin.startsWith('https:') ? '; Secure' : '';
  const stateCookie = (value: string, maxAge: number) =>
    `${STATE_COOKIE}=${value}; Path=/api/auth/github; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
  const limited = (req: express.Request, res: express.Response) => {
    const retry = limit(req.ip ?? 'unknown', now());
    if (retry) res.status(429).set('Retry-After', String(Math.ceil(retry / 1000))).json({ message: 'Please wait before trying again.' });
    return !!retry;
  };
  router.use((_req, res, next) => { res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); next(); });

  // ?client_state=<the web app's random state> is required and comes back with the result. ?return=/viewer/... comes back
  // to that page; ?prompt=select_account lets the person pick another GitHub account.
  router.get('/github/start', (req, res) => {
    if (limited(req, res)) return;
    const clientState = req.query.client_state;
    if (typeof clientState !== 'string' || !CLIENT_STATE.test(clientState)) { res.status(400).json({ message: 'Start sign-in from the MyLittleSwarm app.' }); return; }
    const pending = { state: randomBytes(32).toString('base64url'), verifier: randomBytes(32).toString('base64url'), clientState, back: returnPath(req.query.return) };
    const authorize = new URL('https://github.com/login/oauth/authorize');
    authorize.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: callbackUrl(config), scope: 'read:user user:email',
      state: pending.state, code_challenge: createHash('sha256').update(pending.verifier).digest('base64url'), code_challenge_method: 'S256',
      allow_signup: 'false', ...(req.query.prompt === 'select_account' ? { prompt: 'select_account' } : {}) }).toString();
    res.set('Set-Cookie', stateCookie(encodePending(pending), STATE_TTL_SECONDS)).redirect(302, authorize.toString());
  });

  router.get('/github/callback', (req, res) => {
    if (limited(req, res)) return;
    // The state is single-use whatever happens next.
    res.set('Set-Cookie', stateCookie('', 0));
    const pending = decodePending(cookieOf(req.headers.cookie, STATE_COOKIE));
    // Without a valid cookie there is no state to echo; the app then ignores the result as one it did not start.
    const back = (fragment: string) => res.redirect(303,
      `${config.origin}${pending?.back ?? WEB_BASE}#${fragment}${pending ? `&mlswarm_state=${pending.clientState}` : ''}`);
    const query = z.object({ code: z.string().min(1).max(512), state: z.string().max(64) }).safeParse(req.query);
    if (!query.success || !pending || !sameState(query.data.state, pending.state)) {
      back('mlswarm_sign_in_error=retry'); return;
    }
    void (async () => {
      const account = await confirmGithubAccount(await exchangeCode(config, query.data.code, pending.verifier));
      if (!account.emails.length) throw unverified();
      const { token } = await issueGithubSession(account, now);
      await followGithubUsername(account);
      back(`mlswarm_session=${token}`);
    })().catch(error => {
      if (!(error instanceof Refusal)) console.error('Self-hosted GitHub sign-in failed.');
      back(`mlswarm_sign_in_error=${error instanceof Refusal ? 'refused' : 'unavailable'}`);
    });
  });

  return router;
}
