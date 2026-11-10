import express, { type NextFunction, type Request, type Response } from 'express';
import { HOSTING_LIMITS, HostingError } from '@mlswarm/contracts';
import { ZodError } from 'zod';
import { personFromIdToken, hashToken } from '../auth.js';
import { ownerFromToken, ownerVerification } from '../owner/routes.js';
import { agentFromRequest } from '../v2/agent-auth.js';
import { inProject } from '../firestore.js';
import { Refusal } from '../errors.js';
import { requestLimits } from '../request-state.js';
import { validProjectId } from '../projects/access.js';
import type { HostingActor } from './authority.js';
import { configureHosting, prepareHosting, uploadHostingFile, hostingUploadStatus, sealHosting, requestHostingPublication,
  requestHostingUnpublish, applyHostingOperation, readHosting, readPublicHosting, readHostingCandidate, hostingOperationReceipt } from './service.js';

const statuses: Record<string, number> = { unauthorized: 401, forbidden: 403, not_found: 404, bad_input: 400,
  intent_conflict: 409, project_busy: 503, too_long: 413, rate_limited: 429, run_superseded: 409, hosting_upload_expired: 410 };
function fail(res: Response, error: unknown) {
  if (error instanceof Refusal) {
    if (error.retryAfterSeconds) res.set('Retry-After', String(error.retryAfterSeconds));
    res.status(statuses[error.code] ?? 400).json({ error: error.code, message: error.message });
  } else if (error instanceof ZodError || error instanceof HostingError || (error as { type?: string })?.type === 'entity.too.large') {
    res.status((error as { type?: string })?.type === 'entity.too.large' ? 413 : 400).json({ error: 'bad_input', message: 'Check the hosting input, manifest and file-size limits.' });
  } else {
    console.error('Hosting operation was not confirmed.', error);
    res.status(503).json({ error: 'hosting_unconfirmed', message: 'Hosting did not confirm this operation. Retry the same request ID and bytes.' });
  }
}
// One budget across agent and approved-computer ingress. Hold the slot until provider work finishes,
// including after a disconnected caller; otherwise aborted requests could exceed the budget.
let fileUploads = 0;
function fileUpload(work: (req: Request, res: Response) => Promise<unknown>) {
  const parse = express.raw({ type: () => true, limit: HOSTING_LIMITS.fileBytes });
  return async (req: Request, res: Response) => {
    if (fileUploads >= 2) { fail(res, new Refusal('rate_limited', 'Two file uploads are already in progress. Retry this file.', 1)); return; }
    fileUploads++;
    try {
      await new Promise<void>((resolve, reject) => parse(req, res, error => error ? reject(error) : resolve()));
      if (!req.aborted) res.json(await work(req, res));
    } catch (error) { if (!res.destroyed) fail(res, error); }
    finally { fileUploads--; }
  };
}
export function projectHostingRoutes(now: () => number) {
  const router = express.Router();
  const admission = requestLimits.limiter(() => 'hosting-api', 120, 60_000);
  const controlAdmission = requestLimits.limiter(() => 'hosting-owner-control', 30, 60_000);
  const publicAdmission = requestLimits.limiter(() => 'hosting-public', 60, 60_000);
  router.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
  router.get('/public/:id', (req, res) => { void (async () => {
    if (Object.keys(req.query).length) throw new Refusal('bad_input', 'Public output reads do not accept filters.');
    const retry = publicAdmission(req.ip ?? 'unknown', now());
    if (retry > 0) throw new Refusal('rate_limited', 'Wait before refreshing this output.', Math.ceil(retry / 1000));
    return readPublicHosting(String(req.params.id));
  })().then(value => res.json(value), error => fail(res, error)); });
  router.use(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const token = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
      if (!token) throw new Refusal('unauthorized', 'Sign in to manage project hosting.');
      const person = await personFromIdToken(token);
      if (req.get('X-Mlswarm-Profile-Id') && req.get('X-Mlswarm-Profile-Id') !== person.id) throw new Refusal('unauthorized', 'Your signed-in account changed.');
      res.locals.hostingActor = { kind: 'person', person } satisfies HostingActor;
      const priority = req.method === 'POST' && /^\/[^/]+\/(?:unpublish|operations\/[^/]+\/retry)$/.test(req.path);
      const retry = (priority ? controlAdmission : admission)(person.id, now());
      if (retry > 0) throw new Refusal('rate_limited', 'Wait a moment before making more hosting requests.', Math.ceil(retry / 1000));
      next();
    } catch (error) { fail(res, error); }
  });
  return hostingManagementRoutes(router, now, false);
}

/** MCP uses the approved computer, not a browser sign-in or an agent execution grant. */
export function projectHostingComputerRoutes(now: () => number) {
  const router = express.Router();
  const admission = requestLimits.limiter(() => 'hosting-computer-api', 120, 60_000);
  const priorityAdmission = requestLimits.limiter(() => 'hosting-computer-control', 30, 60_000);
  router.use(async (req: Request, res: Response, next: NextFunction) => {
    res.set('Cache-Control', 'private, no-store');
    try {
      const token = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
      if (!token) throw new Refusal('unauthorized', 'Use this computer’s current MyLittleSwarm approval.');
      const { person, connectionId } = await ownerVerification(() => ownerFromToken(token, now));
      if (req.get('X-Mlswarm-Profile-Id') && req.get('X-Mlswarm-Profile-Id') !== person.id) throw new Refusal('unauthorized', 'Your signed-in account changed.');
      const priority = req.method === 'POST' && /^\/[^/]+\/(?:unpublish|operations\/[^/]+\/retry)$/.test(req.path);
      const retry = (priority ? priorityAdmission : admission)(connectionId, now());
      if (retry > 0) throw new Refusal('rate_limited', 'Wait before uploading more files.', Math.ceil(retry / 1000));
      res.locals.hostingActor = { kind: 'person', person, computer: { connectionId, tokenHashDigest: hashToken(hashToken(token)) } } satisfies HostingActor;
      next();
    } catch (error) { fail(res, error); }
  });
  return hostingManagementRoutes(router, now, true);
}

function hostingManagementRoutes(router: ReturnType<typeof express.Router>, now: () => number, uploads: boolean) {
  const id = (req: Request) => {
    if (!validProjectId(req.params.id)) throw new Refusal('not_found', 'Choose one of your projects.');
    return req.params.id;
  };
  const actor = (res: Response): HostingActor => res.locals.hostingActor;
  const answer = (res: Response, work: () => Promise<unknown>) => void work().then(value => res.json(value), error => fail(res, error));
  router.get('/:id', (req, res) => answer(res, () => {
    if (Object.keys(req.query).some(key => key !== 'cursor') || req.query.cursor !== undefined && typeof req.query.cursor !== 'string') throw new Refusal('bad_input', 'Use only the hosting cursor.');
    return readHosting(id(req), actor(res), req.query.cursor as string | undefined, now);
  }));
  if (uploads) {
    router.get('/:id/candidates/:candidateId/status', (req, res) => answer(res, () => hostingUploadStatus(id(req), actor(res), String(req.params.candidateId), now)));
    router.post('/:id/candidates/:candidateId/files/:index', fileUpload(async (req, res) => {
      const index = String(req.params.index);
      if (!/^(0|[1-9]\d{0,3})$/.test(index) || !Buffer.isBuffer(req.body)) throw new Refusal('bad_input', 'Upload one reserved file.');
      return uploadHostingFile(id(req), actor(res), String(req.params.candidateId), Number(index), req.body, now);
    }));
  }
  router.use(express.json({ limit: HOSTING_LIMITS.manifestBytes }));
  if (uploads) {
    router.post('/:id/candidates', (req, res) => answer(res, () => prepareHosting(id(req), actor(res), req.body, now)));
    router.post('/:id/candidates/:candidateId/seal', (req, res) => answer(res, () => sealHosting(id(req), actor(res), String(req.params.candidateId), now)));
  }
  router.post('/:id/policy', (req, res) => answer(res, () => configureHosting(id(req), actor(res), req.body, now)));
  router.get('/:id/candidates/:candidateId', (req, res) => answer(res, () => readHostingCandidate(id(req), actor(res), String(req.params.candidateId), now)));
  router.post('/:id/publications', (req, res) => answer(res, async () => {
    const operation = await requestHostingPublication(id(req), actor(res), req.body, now);
    return hostingOperationReceipt(await applyHostingOperation(id(req), actor(res), operation.id, now));
  }));
  router.post('/:id/unpublish', (req, res) => answer(res, async () => {
    const operation = await requestHostingUnpublish(id(req), actor(res), req.body, now);
    return hostingOperationReceipt(await applyHostingOperation(id(req), actor(res), operation.id, now));
  }));
  router.post('/:id/operations/:operationId/retry', (req, res) => answer(res, async () => hostingOperationReceipt(await applyHostingOperation(id(req), actor(res), String(req.params.operationId), now))));
  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => fail(res, error));
  return router;
}

/** Owns bounded parsing before the SDK parser. Every action still checks transactional run authority. */
export function projectHostingAgentRoutes(now: () => number) {
  const router = express.Router({ mergeParams: true });
  const admission = requestLimits.limiter(() => 'hosting-agent-api', 120, 60_000);
  router.use((req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    const id = String(req.params.projectId);
    if (!validProjectId(id)) { fail(res, new Refusal('not_found', 'Project unavailable.')); return; }
    inProject(id, () => { void (async () => {
      const agent = await agentFromRequest(req);
      if (!agent) throw new Refusal('unauthorized', 'Use this agent’s current project connection.');
      const retry = admission(`${id}:${agent.id}`, now());
      if (retry > 0) throw new Refusal('rate_limited', 'Wait before uploading more files.', Math.ceil(retry / 1000));
      res.locals.hostingActor = { kind: 'agent', agent, runId: req.get('x-pilot-run') ?? '' } satisfies HostingActor;
      next();
    })().catch(error => fail(res, error)); });
  });
  const answer = (req: Request, res: Response, work: (id: string, actor: HostingActor) => Promise<unknown>) =>
    void work(String(req.params.projectId), res.locals.hostingActor).then(value => res.json(value), error => fail(res, error));
  router.get('/', (req, res) => answer(req, res, (id, actor) => readHosting(id, actor, undefined, now)));
  router.get('/candidates/:candidateId/status', (req, res) => answer(req, res, (id, actor) => hostingUploadStatus(id, actor, String(req.params.candidateId), now)));
  router.post('/candidates/:candidateId/files/:index', fileUpload(async (req, res) => {
    const index = String(req.params.index);
    if (!/^(0|[1-9]\d{0,3})$/.test(index) || !Buffer.isBuffer(req.body)) throw new Refusal('bad_input', 'Upload one reserved file.');
    return uploadHostingFile(String(req.params.projectId), res.locals.hostingActor, String(req.params.candidateId), Number(index), req.body, now);
  }));
  router.use(express.json({ limit: HOSTING_LIMITS.manifestBytes }));
  router.post('/candidates', (req, res) => answer(req, res, (id, actor) => prepareHosting(id, actor, req.body, now)));
  router.post('/candidates/:candidateId/seal', (req, res) => answer(req, res, (id, actor) => sealHosting(id, actor, String(req.params.candidateId), now)));
  router.post('/publications', (req, res) => answer(req, res, async (id, actor) => {
    const operation = await requestHostingPublication(id, actor, req.body, now);
    return hostingOperationReceipt(await applyHostingOperation(id, actor, operation.id, now));
  }));
  router.post('/operations/:operationId/retry', (req, res) => answer(req, res, async (id, actor) => hostingOperationReceipt(await applyHostingOperation(id, actor, String(req.params.operationId), now))));
  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => fail(res, error));
  return router;
}
