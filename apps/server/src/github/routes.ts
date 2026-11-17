import { createHmac, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { z } from 'zod';
import { Refusal, refusalStatus } from '../errors.js';
import { inProject } from '../firestore.js';
import { ingestGitHub } from './work.js';

const BINDINGS = z.record(z.string().regex(/^[a-f0-9]{64}$/), z.object({
  repositoryId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), secret: z.string().min(32).max(1024),
}).strict());
function webhookBindings(): z.infer<typeof BINDINGS> {
  const raw = process.env.GITHUB_WEBHOOK_BINDINGS;
  if (!raw) return {};
  // Fail startup for invalid trusted configuration without printing its secrets.
  try { return BINDINGS.parse(JSON.parse(raw)); } catch { throw new Error('Invalid GitHub webhook configuration.'); }
}
export function githubRoutes(now: () => number) {
  const bindings = webhookBindings();
  const router = express.Router();
  router.post('/:projectId', (req, res, next) => {
    // Own keys only: an inherited name such as `constructor` is not a configured project.
    if (!Object.hasOwn(bindings, String(req.params.projectId))) { res.status(404).json({ error: 'not_configured' }); return; }
    next();
  }, express.raw({ type: 'application/json', limit: '1mb', inflate: false }), async (req, res) => {
    const id = String(req.params.projectId), binding = bindings[id];
    const signature = req.get('x-hub-signature-256');
    if (!Buffer.isBuffer(req.body) || !signature || !/^sha256=[a-f0-9]{64}$/.test(signature)) {
      res.status(401).json({ error: 'invalid_signature' }); return;
    }
    const expected = createHmac('sha256', binding.secret).update(req.body).digest();
    if (!timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'))) {
      res.status(401).json({ error: 'invalid_signature' }); return;
    }
    const event = req.get('x-github-event');
    const resource = event === 'issues' ? 'issues' : event === 'pull_request' ? 'pull_requests' : event === 'milestone' ? 'milestones' : null;
    if (!resource) { res.status(202).json({ ignored: true }); return; }
    try {
      const result = await inProject(id, () => ingestGitHub(resource, req.body, req.get('x-github-delivery') ?? '', binding, now));
      res.status(200).json(result);
    } catch (error) {
      if (error instanceof Refusal) {
        res.status(refusalStatus(error.code)).json({ error: error.code });
      } else {
        console.error('GitHub observation ingestion failed; retry the same delivery.');
        res.status(503).json({ error: 'retry_delivery' });
      }
    }
  });
  return router;
}
