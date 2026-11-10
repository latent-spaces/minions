import express, { type Request, type Response, type NextFunction } from 'express';
import { PROGRESS_LIMITS } from '@mlswarm/contracts';
import { personFromIdToken } from '../auth.js';
import { bearerToken } from '../bearer.js';
import { Refusal, sendRefusal } from '../errors.js';
import { requestLimits } from '../request-state.js';
import { validProjectId } from './access.js';
import type { ProgressActor } from './progress-authority.js';
import { publishProgressUpdate, readProgressUpdates } from './progress.js';
import { uploadProgressScreenshot, readProgressScreenshot } from './progress-media.js';

function fail(res: Response, error: unknown) {
  if (error instanceof Refusal) sendRefusal(res, error);
  else {
    console.error('Project progress request failed.', error);
    res.status(500).json({ error: 'internal_error', message: 'Something went wrong saving this. Try again in a moment.' });
  }
}
const projectId = (req: Request) => {
  if (!validProjectId(req.params.id)) throw new Refusal('not_found', 'Choose one of your projects.');
  return req.params.id;
};

export function projectProgressRoutes(now: () => number) {
  const router = express.Router();
  const readAdmission = requestLimits.limiter(() => 'progress-reads', 60, 60_000);
  const writeAdmission = requestLimits.limiter(() => 'progress-writes', 60, 60_000);
  router.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
  const answer = (res: Response, work: () => Promise<unknown>) => void work().then(value => res.json(value), error => fail(res, error));
  const admission = (req: Request, res: Response, next: NextFunction) => {
    const retry = (req.method === 'GET' ? readAdmission : writeAdmission)(res.locals.actor ? `person:${res.locals.actor.person.id}` : `guest:${req.ip}`, now());
    if (retry > 0) { fail(res, new Refusal('rate_limited', 'Too many requests. Wait a moment, then try again.', Math.ceil(retry / 1000))); return; }
    next();
  };
  const authenticate = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const token = bearerToken(req.headers.authorization);
      if (!token) throw new Refusal('unauthorized', 'Sign in to publish a project update.');
      res.locals.actor = { kind: 'person', person: await personFromIdToken(token) } satisfies ProgressActor;
      next();
    } catch (error) { fail(res, error); }
  };
  const read = (req: Request, res: Response, actor: ProgressActor | null) => answer(res, () => readProgressUpdates(projectId(req), actor, req.query, now));
  const image = async (req: Request, res: Response, actor: ProgressActor | null) => {
    try {
      if (Object.keys(req.query).length) throw new Refusal('bad_input', 'Image requests do not accept filters.');
      const value = await readProgressScreenshot(projectId(req), actor, String(req.params.uploadId));
      res.set('X-Content-Type-Options', 'nosniff').set('Content-Type', value.mimeType).send(value.bytes);
    } catch (error) { fail(res, error); }
  };
  router.get('/public/:id', admission, (req, res) => read(req, res, null));
  router.get('/public/:id/media/:uploadId', admission, (req, res) => void image(req, res, null));
  router.get('/:id', authenticate, admission, (req, res) => read(req, res, res.locals.actor));
  router.get('/:id/media/:uploadId', authenticate, admission, (req, res) => void image(req, res, res.locals.actor));
  router.post('/:id', authenticate, admission, express.json({ limit: PROGRESS_LIMITS.inputBytes }), (req, res) => answer(res, () => publishProgressUpdate(projectId(req), res.locals.actor, req.body, now)));
  router.post('/:id/uploads/:requestId', authenticate, admission, express.raw({ type: () => true, limit: PROGRESS_LIMITS.uploadBytes }), (req, res) => answer(res, () => {
    if (!Buffer.isBuffer(req.body)) throw new Refusal('bad_input', 'Send image file bytes.');
    return uploadProgressScreenshot(projectId(req), res.locals.actor, String(req.params.requestId), String(req.headers['content-type'] ?? '').split(';')[0], req.body, now);
  }));
  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if ((error as { type?: string }).type === 'entity.too.large') fail(res, new Refusal('bad_input', 'This update or screenshot is too large.'));
    else fail(res, error);
  });
  return router;
}
