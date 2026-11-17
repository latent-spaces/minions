// The web app's session endpoint on the self-hosted engine: who the single local owner's session token signs in as.
import express from 'express';
import { bearerToken } from '../bearer.js';
import type { IdentityProvider } from './provider.js';

/** Mount at /api/auth. */
export function sessionRoutes(provider: () => IdentityProvider) {
  const router = express.Router();
  router.use((_req, res, next) => { res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); next(); });
  // Who the bearer token signs in as, for the web app's SessionUser.
  router.get('/session', (req, res) => {
    void provider().verifySession(bearerToken(req.headers.authorization) ?? '').then(session => {
      if (!session) { res.status(401).json({ message: 'Sign in again.' }); return; }
      res.json({ subject: session.subject, email: session.email, displayName: session.name });
    }, () => { console.error('Session lookup failed.'); res.status(500).json({ message: 'Something went wrong. Try again in a moment.' }); });
  });
  return router;
}
