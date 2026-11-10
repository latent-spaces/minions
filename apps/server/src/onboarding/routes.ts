import express, { type Response, type Router } from 'express';
import { z } from 'zod';
import { personFromIdToken, signInRequired } from '../auth.js';
import { bearerToken } from '../bearer.js';
import { requestLimits } from '../request-state.js';
import { Refusal, sendRefusal } from '../errors.js';
import { projectRole } from '../projects/access.js';
import { currentProjectId } from '../firestore.js';
import { revokeOwned } from './store.js';

import { registerAgent } from './registration.js';


const ID = /^[\w-]{1,200}$/;

export function onboardingRoutes(now: () => number): Router {
  const router = express.Router();
  router.use(express.json({ limit: '16kb' }));
  // One Cloud Run instance in the capped pilot. Not a distributed rate limiter for 5,000 agents.
  const admission = requestLimits.limiter(() => `joining:${currentProjectId()}`, 30, 60_000);
  function limit(key: string) {
    const retry = admission(key, now());
    if (retry > 0) throw new Refusal('rate_limited', 'Too many requests. Wait a moment, then try again.', Math.ceil(retry / 1000));
  }
  router.use(async (req, res, next) => {
    try {
      const token = bearerToken(req.headers.authorization);
      if (!token) throw new Refusal('unauthorized', signInRequired('Sign in with GitHub first.'));
      const person = await personFromIdToken(token);
      limit(`person:${person.id}`);
      await projectRole(person);  // Refuses anyone who is not a member of this project.
      res.locals.person = person;
      next();
    } catch (error) { fail(res, error); }
  });
  router.post('/agents/register', (req, res) => answer(res, async () => {
    const body = z.object({ name: z.string().trim().min(1).max(64) }).strict().safeParse(req.body);
    if (!body.success) throw new Refusal('bad_input', 'Choose a short agent name.');
    return registerAgent(res.locals.person.id, body.data.name, now);
  }));
  router.post('/agents/:id/revoke', (req, res) => answer(res, async () => {
    const id = String(req.params.id);
    if (!ID.test(id)) throw new Refusal('bad_input', 'Use the agent’s exact ID from your agent list.');
    await revokeOwned(res.locals.person.id, id, now);
    return { ok: true };
  }));
  return router;
}

async function answer(res: Response, action: () => Promise<object>) {
  res.set('Cache-Control', 'no-store');
  try { res.json(await action()); } catch (error) { fail(res, error); }
}
function fail(res: Response, error: unknown) {
  res.set('Cache-Control', 'no-store');
  if (error instanceof Refusal) sendRefusal(res, error);
  else {
    console.error('An onboarding request failed.', error);
    res.status(500).json({ error: 'internal_error', message: 'The connection could not be updated. Try again.' });
  }
}
