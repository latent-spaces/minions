// The web app's session endpoints on a self-hosted engine, for whichever sign-in service is installed
// (GitHub sessions or the single local owner). The hosted service keeps Firebase's client-side session.
import express from 'express';
import { bearerToken } from '../bearer.js';
import type { IdentityProvider } from './provider.js';

/** Mount at /api/auth. `signOut` ends the presented session; a provider without sessions to end can resolve without doing anything. */
export function sessionRoutes(provider: () => IdentityProvider, signOut: (token: string) => Promise<void>) {
  const router = express.Router();
  router.use((_req, res, next) => { res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); next(); });
  // Who the bearer token signs in as, for the web app's SessionUser.
  router.get('/session', (req, res) => {
    void provider().verifySession(bearerToken(req.headers.authorization) ?? '').then(session => {
      if (!session) { res.status(401).json({ message: 'Sign in again.' }); return; }
      res.json({ subject: session.subject, email: session.email, displayName: session.name });
    }, () => { console.error('Session lookup failed.'); res.status(500).json({ message: 'Something went wrong. Try again in a moment.' }); });
  });
  router.post('/session/revoke', (req, res) => {
    void signOut(bearerToken(req.headers.authorization) ?? '').then(() => { res.status(204).end(); },
      () => { console.error('Sign-out failed.'); res.status(500).json({ message: 'Something went wrong. Try again in a moment.' }); });
  });
  return router;
}
