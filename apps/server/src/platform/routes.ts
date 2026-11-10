import { platformContext } from '../analytics/context.js';
import { readPlatformAnalytics } from '../analytics/read.js';
import { readOnboardingTimings } from './onboarding.js';
import { z } from 'zod';
import express from 'express';
import { lookupPlatformUsers, readPlatformHealth, readUserConnections } from './diagnostics.js';
import { personIdentityFromIdToken } from '../auth.js';
import { bearerToken } from '../bearer.js';
import { Refusal, sendRefusal } from '../errors.js';
import { agentsPerParticipantLimit, platformSettings, privateParticipantLimit, PLATFORM_UPDATE, readPlatformSettings, updatePlatformSettings } from './settings.js';
import type { CommunityActor } from '../community/identity.js';
export function platformRoutes(now: () => number) {
  const router = express.Router();
  router.use(express.json({ limit: '16kb' }));
  router.use(async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    try {
      const token = bearerToken(req.headers.authorization);
      if (!token) throw new Refusal('unauthorized', 'Sign in with the GitHub account you use for MyLittleSwarm.');
      const { person, adminAuthenticated, verifiedGithubSession } = await personIdentityFromIdToken(token);
      res.locals.person = person;
      res.locals.actor = { kind: 'person', operatorId: person.id, adminAuthenticated, verifiedGithubSession } satisfies CommunityActor;
      next();
    } catch (error) { next(error); }
  });
  router.get('/onboarding', async (req, res, next) => {
    try { res.json(await readOnboardingTimings(res.locals.actor, req.query, now)); } catch (error) { next(error); }
  });
  for(const kind of ['runs','turns','now'] as const) router.get(`/analytics/context-${kind}`, async(req,res,next)=>{try{res.json(await platformContext(res.locals.actor,req.query,kind));}catch(error){next(error);}});
  router.get('/analytics', async (req, res, next) => {
    try { res.json(await readPlatformAnalytics(res.locals.actor, req.query, now)); } catch (error) { next(error); }
  });
  router.get('/health', async (_req, res, next) => {
    try { res.json(await readPlatformHealth(res.locals.actor, now)); } catch (error) { next(error); }
  });
  router.get('/users', async (req, res, next) => {
    try { res.json(await lookupPlatformUsers(res.locals.actor, req.query, now)); } catch (error) { next(error); }
  });
  router.get('/users/:profileId/connections', async (req, res, next) => {
    try { res.json(await readUserConnections(res.locals.actor, req.params.profileId, req.query, now)); } catch (error) { next(error); }
  });
  router.get('/limits', async (_req, res, next) => {
    try { const settings = (await platformSettings.get()).data(); res.json({ maxContributors: settings?.maxContributors ?? null, maxPrivateParticipants: privateParticipantLimit(settings), maxAgentsPerParticipant: agentsPerParticipantLimit(settings) }); } catch (error) { next(error); }
  });
  router.get('/settings', async (_req, res, next) => {
    try { res.json(await readPlatformSettings(res.locals.actor)); } catch (error) { next(error); }
  });
  router.post('/settings', async (req, res, next) => {
    try {
      const parsed = PLATFORM_UPDATE.safeParse(req.body);
      if (!parsed.success) throw new Refusal('bad_input', 'Supply a positive contributor maximum, approved reviewer emails and the current revision.');
      res.json(await updatePlatformSettings(res.locals.actor, parsed.data, now));
    } catch (error) { next(error); }
  });
  router.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof z.ZodError) res.status(400).json({error:'bad_input',message:'Check the request details and retry.'});
    else if (error instanceof Refusal) sendRefusal(res, error);
    else if ((error as { type?: string })?.type === 'entity.too.large') res.status(413).json({ error: 'bad_input', message: 'Keep settings within 16 KiB.' });
    else { console.error('Platform settings request failed.', error); res.status(500).json({ error: 'internal', message: 'Could not complete this request.' }); }
  });
  return router;
}
