// Only the standalone launcher mounts this router, after installing its local-owner provider.
// A private operator file holds a short-lived code; raw sessions stay in memory and the browser.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { bearerToken } from './bearer.js';
import { deploymentKind } from './deployment.js';

const CODE = /^[A-Za-z0-9_-]{43}$/;
const STATE = /^[A-Za-z0-9_-]{20,128}$/;
const lifetime = 5 * 60_000;
const digest = (value: string) => createHash('sha256').update(value).digest();
type OwnerIdentity = { issueSession(): string; verifySession(token: string): Promise<unknown> };

type Handoff = { hash: Buffer; expiresAt: number; state?: string; token?: string };
export function localOwnerHandoff({ provider, installed, origin, now = Date.now }: {
  provider: OwnerIdentity;
  /** The engine checks provider identity, not merely a configured mode string. */
  installed(): boolean;
  origin(): string;
  now?: () => number;
}) {
  let current: Handoff | undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  let windowAt = now(), requests = 0;
  const clear = () => { current = undefined; if (expiry) clearTimeout(expiry); expiry = undefined; };
  const create = () => {
    if (deploymentKind() !== 'self-hosted' || !installed()) throw new Error('Local owner sign-in is not installed.');
    const target = new URL(origin());
    if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || target.origin !== origin()) throw new Error('Local owner links require a literal loopback engine origin.');
    clear();
    const code = randomBytes(32).toString('base64url');
    current = { hash: digest(code), expiresAt: now() + lifetime };
    expiry = setTimeout(clear, lifetime); expiry.unref();
    return { url: `${target.origin}/viewer/#mlswarm_owner_code=${code}`, expiresAt: current.expiresAt };
  };
  const router = express.Router();
  router.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    if (deploymentKind() !== 'self-hosted' || !installed()) { res.status(404).json({ message: 'Local owner sign-in is unavailable.' }); return; }
    const expected = new URL(origin());
    const remote = req.socket.remoteAddress;
    if (expected.protocol !== 'http:' || expected.hostname !== '127.0.0.1'
      || (remote !== '127.0.0.1' && remote !== '::ffff:127.0.0.1')
      || req.headers.host !== expected.host || req.headers.origin !== expected.origin) {
      res.status(403).json({ message: 'Open this link on the engine computer using its loopback address.' }); return;
    }
    // Bound guessing and secret-signing work across this one-owner loopback service.
    if (now() - windowAt >= 60_000) { windowAt = now(); requests = 0; }
    if (++requests > 30) { res.set('Retry-After', '60').status(429).json({ message: 'Too many sign-in attempts. Try again in a minute.' }); return; }
    next();
  });
  router.use(express.json({ limit: '2kb', strict: true }));
  router.post('/exchange', (req, res) => {
    const body = req.body as Record<string, unknown> | undefined;
    if (req.headers.authorization || !body || Object.keys(body).some(key => key !== 'code' && key !== 'client_state')
      || typeof body.code !== 'string' || !CODE.test(body.code)
      || typeof body.client_state !== 'string' || !STATE.test(body.client_state)) {
      res.status(400).json({ message: 'Use the complete owner sign-in link.' }); return;
    }
    if (current && now() >= current.expiresAt) clear();
    if (!current || !timingSafeEqual(digest(body.code), current.hash) || (current.state !== undefined && current.state !== body.client_state)) {
      res.status(401).json({ message: 'This owner link expired or was already used. Ask the engine for a new one.' }); return;
    }
    // The first state owns this code. Only an identical retry can recover a lost response.
    current.state = body.client_state;
    current.token ??= provider.issueSession();
    res.json({ token: current.token, client_state: current.state });
  });
  router.post('/handoff', (req, res) => {
    void provider.verifySession(bearerToken(req.headers.authorization) ?? '').then(session => {
      if (!session) { res.status(401).json({ message: 'A current local owner session is required.' }); return; }
      res.json(create());
    }, () => { res.status(500).json({ message: 'Could not create an owner link.' }); });
  });
  // JSON parser failures must match the browser contract without echoing secret request bytes.
  router.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = error && typeof error === 'object' && 'status' in error && error.status === 413 ? 413 : 400;
    res.status(status).json({ message: 'Provide a small JSON sign-in request.' });
  });
  return { router, create, clear };
}
