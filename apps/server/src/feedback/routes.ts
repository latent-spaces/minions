import express from 'express';
import { localhostHostValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import { personIdentityFromIdToken } from '../auth.js';
import { bearerToken } from '../bearer.js';
import { Refusal, sendRefusal } from '../errors.js';
import { requestLimits } from '../request-state.js';
import type { CommunityActor } from '../community/identity.js';
import { feedbackPreferences, listFeedback, readFeedback, submitFeedback, updateFeedback } from './store.js';

/** Before the SDK's 100KiB JSON parser; retain Host-before-body and authenticate uploads first. */
export function feedbackRoutes(host: string, now = Date.now) {
  const router = express.Router(), admit = requestLimits.limiter(() => 'feedback', 30, 60_000);
  if (['127.0.0.1', 'localhost', '::1'].includes(host)) router.use(localhostHostValidation());
  router.use(async (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    try {
      const token = bearerToken(req.headers.authorization);
      if (!token) throw new Refusal('unauthorized', 'Sign in to send or read feedback.');
      const session = await personIdentityFromIdToken(token), retry = admit(session.person.id, now());
      if (retry > 0) throw new Refusal('rate_limited', 'Wait before requesting more feedback.', Math.ceil(retry / 1000));
      res.locals.actor = { kind: 'person', operatorId: session.person.id, adminAuthenticated: session.adminAuthenticated } satisfies CommunityActor;
      if (req.method === 'POST' && req.headers['x-mlswarm-profile-id'] !== session.person.id) throw new Refusal('forbidden', 'Your account changed. Reload before sending feedback.');
      next();
    } catch (e) { next(e); }
  });
  router.use(express.json({ limit: '3mb' }));
  router.use((req, _res, next) => { if (Object.keys(req.query).some(k => req.path !== '/admin' || !['status', 'cursor'].includes(k))) next(new Refusal('bad_input', 'Unsupported feedback filters.')); else next(); });
  router.post('/reports', async (req, res, next) => { try { res.json(await submitFeedback(res.locals.actor, req.body, now)); } catch (e) { next(e); } });
  router.get('/preferences', async (_req, res, next) => { try { res.json(await feedbackPreferences(res.locals.actor)); } catch (e) { next(e); } });
  router.post('/preferences', async (req, res, next) => { try { res.json(await feedbackPreferences(res.locals.actor, req.body)); } catch (e) { next(e); } });
  router.get('/admin', async (req, res, next) => { try { res.json(await listFeedback(res.locals.actor, String(req.query.status ?? 'new'), req.query.cursor === undefined ? undefined : String(req.query.cursor))); } catch (e) { next(e); } });
  router.get('/reports/:id', async (req, res, next) => { try { res.json(await readFeedback(res.locals.actor, String(req.params.id))); } catch (e) { next(e); } });
  router.get('/reports/:id/screenshot', async (req, res, next) => { try { const result = await readFeedback(res.locals.actor, String(req.params.id), true); if (!('bytes' in result)) throw new Error('Missing screenshot bytes'); res.set('X-Content-Type-Options', 'nosniff').type('image/webp').send(result.bytes); } catch (e) { next(e); } });
  router.post('/reports/:id/status', async (req, res, next) => { try { res.json(await updateFeedback(res.locals.actor, String(req.params.id), req.body, now)); } catch (e) { next(e); } });
  router.use((_req, _res, next) => next(new Refusal('not_found', 'This feedback endpoint does not exist.')));
  router.use((e: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (e instanceof Refusal) sendRefusal(res, e);
    else if ((e as { type?: string })?.type === 'entity.too.large') res.status(413).json({ message: 'Keep screenshot uploads within 2 MiB.' });
    else if (e instanceof SyntaxError) res.status(400).json({ message: 'Send valid JSON.' });
    else { console.error('Feedback request failed.'); res.status(500).json({ message: 'Could not complete this feedback request. Try again.' }); }
  });
  return router;
}
