import { createHash } from 'node:crypto';
import express from 'express';
import { z } from 'zod';
import { personFromIdToken } from './auth.js';
import { bearerToken } from './bearer.js';
import { collection, db } from './firestore.js';
import { Refusal, refusalStatus } from './errors.js';
import { requestLimits } from './request-state.js';

// Stored links may still name a removed project join link (projectJoin); those no longer resolve.
type SharedLink = { path: string } | { projectJoin: { projectId: string; codeHash: string } };
const links = collection<SharedLink>('sharedLinks');
const validCode = /^[A-Za-z0-9_-]{22}$/;
// Only the app page is a destination: no external redirects, API actions or nested aliases. Links saved before
// the app moved to the root name /viewer/?…; they still resolve, and /viewer/ redirects to the root.
export function sharedDestination(path: string): boolean {
  if (!/^\/(?:viewer\/)?\?/.test(path) || path.length > 4096 || /[\s\x00-\x1f\x7f\\#]/.test(path)) return false;
  const url = new URL(path, 'https://mlswarm.invalid');
  return (url.pathname === '/' || url.pathname === '/viewer/') && url.origin === 'https://mlswarm.invalid';
}

// The app used to live under /viewer/. Saved links, project updates and older connectors still name it, so those
// addresses move permanently to the same page at the root (owner, 11 November 2026).
export const LEGACY_APP_PATH = /^\/viewer(?:\/|$)/;
export function legacyAppRedirect(req: express.Request, res: express.Response): void {
  res.redirect(301, req.originalUrl.replace(/^\/viewer\/?/, '/'));
}

/** A stable 22-character hash alias. Destination authorization, confirmation and expiry still apply. */
export async function shortSharedLink(path: string): Promise<string> {
  if (!sharedDestination(path)) throw new Refusal('bad_input', 'Choose a MyLittleSwarm page to share.');
  const code = createHash('sha256').update(`mlswarm-share-v1:${path}`).digest('base64url').slice(0, 22);
  await db.runTransaction(async tx => {
    const ref = links.doc(code), previous = await tx.get(ref);
    const destination: SharedLink = { path };
    if (previous.exists) {
      const saved = previous.data()!;
      if (!('path' in saved) || saved.path !== destination.path) throw new Error('Shared link collision.');
    } else tx.create(ref, destination);
  });
  return `/s/${code}`;
}

export function sharedLinkRoutes(now: () => number) {
  const router = express.Router();
  const limit = requestLimits.limiter(() => 'shared-links', 60, 60_000);
  router.use('/api/shared-links', express.json({ limit: '8kb' }));
  router.use(['/api/shared-links', '/s'], (_req, res, next) => { res.set('Cache-Control', 'private,no-store').set('Referrer-Policy', 'no-referrer'); next(); });
  router.post('/api/shared-links', async (req, res, next) => {
    try {
      const token = bearerToken(req.headers.authorization) ?? '';
      if (req.headers.authorization && !token) throw new Refusal('unauthorized', 'Sign in to share this page.');
      const retry = limit(req.ip ?? 'unknown', now());
      if (retry) { res.set('Retry-After', String(Math.ceil(retry / 1000))).status(429).json({ message: 'Please wait before sharing another link.' }); return; }
      const input = z.object({ path: z.string() }).strict().safeParse(req.body);
      if (!input.success) { res.status(400).json({ message: 'Choose a MyLittleSwarm page to share.' }); return; }
      if (!sharedDestination(input.data.path)) throw new Refusal('bad_input', 'Choose a MyLittleSwarm page to share.');
      await personFromIdToken(token);
      res.json({ path: await shortSharedLink(input.data.path) });
    } catch (error) {
      if (error instanceof Refusal) res.status(refusalStatus(error.code)).json({ message: error.message });
      else next(error);
    }
  });
  router.get('/s/:code', async (req, res, next) => {
    try {
      const code = String(req.params.code);
      const saved = validCode.test(code) ? (await links.doc(code).get()).data() : undefined;
      const path = saved && 'path' in saved ? saved.path : undefined;
      if (!path || !sharedDestination(path)) { res.status(404).send('This link is unavailable. Ask the sender for a new link.'); return; }
      res.redirect(302, path);
    } catch (error) { next(error); }
  });
  return router;
}
