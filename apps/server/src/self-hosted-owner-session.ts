// Only the standalone launcher mounts this router, after installing its local-owner provider.
// The local app has one person: a page served by this engine on this computer gets the owner's session without a
// sign-in step (owner decision, 10 November 2026). The checks below keep other websites and rebinding hosts out.
import express from 'express';
import { deploymentKind } from './deployment.js';

type OwnerIdentity = { issueSession(): string };
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost'];

export function localOwnerSession({ provider, installed, origin, now = Date.now }: {
  provider: OwnerIdentity;
  /** The engine checks provider identity, not merely a configured mode string. */
  installed(): boolean;
  origin(): string;
  now?: () => number;
}) {
  let windowAt = now(), requests = 0;
  const router = express.Router();
  router.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    if (deploymentKind() !== 'self-hosted' || !installed()) { res.status(404).json({ message: 'Local owner sign-in is unavailable.' }); return; }
    const expected = new URL(origin());
    const remote = req.socket.remoteAddress;
    // The Host header names this engine (no DNS rebinding) and the Origin header is this engine's own page (no other
    // website). A JSON POST from another origin is preflighted, and this router answers no preflight.
    const host = LOOPBACK_HOSTS.map(name => `${name}:${expected.port}`).find(value => value === req.headers.host);
    if (expected.protocol !== 'http:' || expected.hostname !== '127.0.0.1'
      || (remote !== '127.0.0.1' && remote !== '::ffff:127.0.0.1' && remote !== '::1')
      || !host || req.headers.origin !== `http://${host}` || req.headers['content-type'] !== 'application/json'
      || (req.headers['sec-fetch-site'] !== undefined && req.headers['sec-fetch-site'] !== 'same-origin')) {
      res.status(403).json({ message: 'Open Minions on this computer at its own address.' }); return;
    }
    // Bound secret-signing work across this one-owner loopback service.
    if (now() - windowAt >= 60_000) { windowAt = now(); requests = 0; }
    if (++requests > 30) { res.set('Retry-After', '60').status(429).json({ message: 'Too many requests. Try again in a minute.' }); return; }
    next();
  });
  router.post('/session', (_req, res) => { res.json({ token: provider.issueSession() }); });
  return router;
}
