import express, { type Response, type Router } from 'express';
import { z } from 'zod';
import { personIdentityFromIdToken } from '../auth.js';
import { bearerToken } from '../bearer.js';
import { requestLimits } from '../request-state.js';
import { Refusal, sendRefusal } from '../errors.js';
import { readAccountCleanup, continueAccountCleanup } from '../store/account-cleanup.js';
import { communityAccount, type CommunityActor } from './identity.js';
import { getProposal, listProposals, REQUEST_ID, REVISION, reviewProposal, writeProposal } from './proposals.js';

import { uploadMaterial, downloadMaterial, removeMaterial, listMaterials, MATERIAL_MAX_BYTES } from './materials.js';
import { readMyProfile, saveMyProfile } from './profile.js';
import { reportWebPresence } from './web-presence.js';
import { karmaProgress } from './karma.js';
import { prepareProfilePhoto, readProfilePhoto } from './profile-photos.js';

export function communityRoutes(now: () => number): Router {
  const router = express.Router();
  router.use(express.json({ limit: '64kb' }));
  // The host MCP app may already have parsed JSON; enforce this router's payload bound too.
  router.use((req, res, next) => {
    if (req.body !== undefined && Buffer.byteLength(JSON.stringify(req.body), 'utf8') > 64 * 1024) {
      res.status(413).set('Cache-Control', 'no-store').json({ error: 'bad_input', message: 'Keep JSON request bodies within 64 KiB.' });
    } else next();
  });
  // A pilot API guard, not a model spending limit or a distributed capacity guarantee.
  const admission = requestLimits.limiter(() => 'community', 60, 60_000);
  function limit(key: string) {
    const retry = admission(key, now());
    if (retry > 0) throw new Refusal('rate_limited', 'Too many requests. Wait a moment, then try again.', Math.ceil(retry / 1000));
  }
  router.use(async (req, res, next) => {
    try {
      const token = bearerToken(req.headers.authorization);
      if (!token) throw new Refusal('unauthorized', 'Sign in with the GitHub account you use for MyLittleSwarm.');
      const { person, adminAuthenticated, verifiedGithubSession, firebaseUid } = await personIdentityFromIdToken(token);
      limit(`person:${person.id}`);
      res.locals.actor = { kind: 'person', operatorId: person.id, adminAuthenticated, verifiedGithubSession, firebaseUid } satisfies CommunityActor;
      next();
    } catch (error) { fail(res, error); }
  });
  // Bind every profile write/preview to the immutable invitation, including same-UID reinvites.
  router.use('/my-profile', (req, res, next) => {
    if (req.method === 'POST' || req.path.startsWith('/photo/')) {
      if (req.headers['x-mlswarm-profile-id'] !== res.locals.actor.operatorId) { fail(res, new Refusal('forbidden', 'Reload your profile, then edit again.')); return; }
    }
    next();
  });
  router.post('/my-profile/photo/upload', express.raw({ type: () => true, limit: 2 * 1024 * 1024 }), (req, res) => answer(res, async () => {
    if (Object.keys(req.query).length || !Buffer.isBuffer(req.body)) throw new Refusal('bad_input', 'Supply raw photo bytes.');
    return prepareProfilePhoto(res.locals.actor, String(req.headers['x-upload-id'] ?? ''), { source: 'upload',
      mime: String(req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase(), bytes: req.body }, now);
  }));
  router.post('/my-profile/photo/github', (req, res) => answer(res, async () => {
    const body = z.object({ client_request_id: z.uuid() }).strict().safeParse(req.body);
    if (!body.success || Object.keys(req.query).length) throw new Refusal('bad_input', 'Supply an immutable GitHub photo request ID.');
    return prepareProfilePhoto(res.locals.actor, body.data.client_request_id, { source: 'github' }, now);
  }));
  router.get('/my-profile/photo/:id', async (req, res) => {
    try {
      if (Object.keys(req.query).length) throw new Refusal('bad_input', 'Photo reads do not accept filters.');
      const bytes = await readProfilePhoto(res.locals.actor.operatorId, String(req.params.id), res.locals.actor, now);
      res.set('Cache-Control', 'private, no-store').set('X-Content-Type-Options', 'nosniff').type('image/webp').send(bytes);
    } catch (error) { fail(res, error); }
  });
  router.post('/web-presence', (req, res) => answer(res, async () => {
    if (req.headers['x-mlswarm-profile-id'] !== res.locals.actor.operatorId) throw new Refusal('forbidden', 'Reload your account, then try again.');
    if (Object.keys(req.query).length) throw new Refusal('bad_input', 'Presence does not accept query options.');
    return reportWebPresence(res.locals.actor, req.body, now);
  }));
  router.get('/me', (_req, res) => answer(res, () => communityAccount(res.locals.actor, now)));
  router.get('/my-karma', (_req, res) => answer(res, () => karmaProgress(res.locals.actor)));
  router.get('/my-profile', (_req, res) => answer(res, () => readMyProfile(res.locals.actor)));
  router.post('/my-profile', (req, res) => answer(res, () => saveMyProfile(res.locals.actor, req.body, now)));
  router.post('/proposals/:id/materials', express.raw({ type: () => true, limit: MATERIAL_MAX_BYTES }), (req, res) => answer(res, async () => {
    const revision = REVISION.safeParse(Number(req.query.expected_revision));
    if (!revision.success || !Buffer.isBuffer(req.body)) throw new Refusal('bad_input', 'Supply raw file bytes and the expected proposal revision.');
    let name: string;
    try { name = decodeURIComponent(String(req.headers['x-file-name'] ?? '')); } catch { throw new Refusal('bad_input', 'Use an encoded filename.'); }
    return uploadMaterial(res.locals.actor, String(req.params.id), revision.data, String(req.headers['x-upload-id'] ?? ''), name, String(req.headers['content-type'] ?? '').split(';')[0]!, req.body, now);
  }));
  router.delete('/proposals/:id/materials/:fileId', (req, res) => answer(res, async () => {
    const parsed = z.object({ expected_revision: REVISION, client_request_id: REQUEST_ID.optional() }).strict().safeParse(req.body);
    if (!parsed.success) throw new Refusal('bad_input', 'Supply the expected proposal revision.');
    return removeMaterial(res.locals.actor, String(req.params.id), String(req.params.fileId), parsed.data.expected_revision, now, parsed.data.client_request_id);
  }));
  router.get('/proposals/:id/materials', (req, res) => answer(res, () => listMaterials(res.locals.actor, String(req.params.id))));
  router.post('/proposals/:id/materials/:fileId/remove', (req, res) => answer(res, async () => {
    const parsed = z.object({ expected_revision: REVISION, client_request_id: REQUEST_ID.optional() }).strict().safeParse(req.body);
    if (!parsed.success) throw new Refusal('bad_input', 'Supply the expected proposal revision.');
    return removeMaterial(res.locals.actor, String(req.params.id), String(req.params.fileId), parsed.data.expected_revision, now, parsed.data.client_request_id);
  }));
  router.get('/proposals/:id/materials/:fileId', async (req, res) => {
    try {
      const { material, bytes } = await downloadMaterial(res.locals.actor, String(req.params.id), String(req.params.fileId));
      res.set('Cache-Control', 'private, no-store').set('X-Content-Type-Options', 'nosniff')
        // Spelled out rather than res.attachment(): that sends a Latin-1 name such as résumé.pdf as raw bytes.
        .set('Content-Type', material.mimeType).set('Content-Disposition', `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(material.name)}`).send(bytes);
    } catch (error) { fail(res, error); }
  });
  router.get('/accounts/:id/cleanup', (req, res) => answer(res, async () => {
    if (Object.keys(req.query).length) throw new Refusal('bad_input', 'Account cleanup does not accept query options.');
    return readAccountCleanup(res.locals.actor.operatorId, String(req.params.id));
  }));
  router.post('/accounts/:id/cleanup', (req, res) => answer(res, async () => {
    if (!z.object({}).strict().safeParse(req.body).success) throw new Refusal('bad_input', 'Supply an empty cleanup request.');
    return continueAccountCleanup(String(req.params.id), now, res.locals.actor.operatorId);
  }));
  router.get('/proposals', (req, res) => answer(res, async () => {
    const parsed = z.object({ cursor: z.string().max(500).optional(), queue: z.enum(['submitted', 'approved']).optional() }).strict().safeParse(req.query);
    if (!parsed.success) throw new Refusal('bad_input', 'Use the returned cursor; reviewers can request queue=submitted or queue=approved.');
    return listProposals(res.locals.actor, parsed.data.cursor, parsed.data.queue === 'approved' ? 'approved' : parsed.data.queue === 'submitted');
  }));
  router.get('/proposals/:id', (req, res) => answer(res, async () => {
    const parsed = z.object({ history_cursor: z.string().max(500).optional() }).strict().safeParse(req.query);
    if (!parsed.success) throw new Refusal('bad_input', 'Use the returned history_cursor.');
    return getProposal(res.locals.actor, String(req.params.id), parsed.data.history_cursor);
  }));
  router.post('/proposals/:id/review', (req, res) => answer(res, async () => {
    const parsed = z.object({ expected_revision: REVISION, client_request_id: REQUEST_ID,
      decision: z.enum(['changes_requested', 'approved', 'rejected']), feedback: z.string().trim().min(1).max(1000) }).strict().safeParse(req.body);
    if (!parsed.success) throw new Refusal('bad_input', 'Supply expected_revision, client_request_id, decision and a concrete feedback reason.');
    return reviewProposal(res.locals.actor, { proposalId: String(req.params.id), expectedRevision: parsed.data.expected_revision,
      clientId: parsed.data.client_request_id, decision: parsed.data.decision, feedback: parsed.data.feedback }, now);
  }));
  // The proposer's own content writes from the web form; owner tools only read proposals. writeProposal validates the
  // content, fields required at submit and byte bound, and applies receipts and revision fences, as a person.
  router.post('/proposals', (req, res) => answer(res, async () => {
    const parsed = z.object({ client_request_id: REQUEST_ID, content: z.unknown() }).strict().safeParse(req.body);
    if (!parsed.success) throw new Refusal('bad_input', 'Supply client_request_id and the proposal content.');
    return writeProposal(res.locals.actor, { action: 'draft', clientId: parsed.data.client_request_id, content: parsed.data.content }, now);
  }));
  router.post('/proposals/:id/update', (req, res) => answer(res, async () => {
    const parsed = z.object({ expected_revision: REVISION, client_request_id: REQUEST_ID, content: z.unknown() }).strict().safeParse(req.body);
    if (!parsed.success) throw new Refusal('bad_input', 'Supply expected_revision, client_request_id and the complete proposal content.');
    return writeProposal(res.locals.actor, { action: 'update', proposalId: String(req.params.id), expectedRevision: parsed.data.expected_revision,
      clientId: parsed.data.client_request_id, content: parsed.data.content }, now);
  }));
  for (const action of ['submit', 'withdraw'] as const) router.post(`/proposals/:id/${action}`, (req, res) => answer(res, async () => {
    const parsed = z.object({ expected_revision: REVISION, client_request_id: REQUEST_ID }).strict().safeParse(req.body);
    if (!parsed.success) throw new Refusal('bad_input', 'Supply expected_revision and client_request_id.');
    return writeProposal(res.locals.actor, { action, proposalId: String(req.params.id), expectedRevision: parsed.data.expected_revision,
      clientId: parsed.data.client_request_id }, now);
  }));
  router.use((error: unknown, _req: express.Request, res: Response, _next: express.NextFunction) => {
    const type = (error as { type?: string })?.type;
    if (type === 'entity.too.large') res.status(413).json({ error: 'bad_input', message: 'The request body exceeds its size limit (files: 10 MB; JSON: 64 KiB).'  });
    else if (type === 'entity.parse.failed') res.status(400).json({ error: 'bad_input', message: 'Send a valid JSON body.' });
    else fail(res, error);
  });
  return router;
}

async function answer(res: Response, action: () => Promise<object>) {
  res.set('Cache-Control', 'no-store');
  try { res.json(await action()); } catch (error) { fail(res, error); }
}
function fail(res: Response, error: unknown) {
  if (res.headersSent) return;
  res.set('Cache-Control', 'no-store');
  if (error instanceof Refusal) {
    if (error.code === 'unauthorized') res.set('WWW-Authenticate', 'Bearer');
    sendRefusal(res, error);
  } else {
    console.error('A community request failed.', error);
    res.status(500).json({ error: 'internal_error', message: 'Something went wrong on MyLittleSwarm. Try again in a moment.' });
  }
}
