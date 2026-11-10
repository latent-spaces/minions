import { join } from 'node:path';
import { z } from 'zod/v4';
import { lstatExists, readPrivate, writePrivate } from './state.mjs';
import { skillTextHash } from './skill-bundle.mjs';

export const WORKER_GUIDE_SECTIONS = Object.freeze(['project-work', 'updates-and-help']);
export const WORKER_GUIDE_TOOL = {
  name: 'get_mlswarm_guide',
  description: 'Read a shared workflow pinned to this approved mission: project-work for tasks, collaboration, recovery and GitHub publication; updates-and-help for updates, Needs you and moderation. Read when needed if not retained in context. Only background-agent paths apply; owner management and in-chat participation tools are unavailable.',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: { type: 'object', properties: { section: { type: 'string', enum: WORKER_GUIDE_SECTIONS } }, required: ['section'], additionalProperties: false },
};
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const snapshotSchema = z.object({
  schema: z.literal(1), guide_revision: z.number().int().positive(), core_sha256: hash,
  sections: z.object(Object.fromEntries(WORKER_GUIDE_SECTIONS.map(name => [name, z.string().min(1).max(65536)]))).strict(),
  sha256: hash,
}).strict();
const payload = value => ({ schema: 1, guide_revision: value.guide_revision, core_sha256: value.core_sha256,
  sections: Object.fromEntries(WORKER_GUIDE_SECTIONS.map(name => [name, value.sections[name]])) });

export function createWorkerGuidance({ core, guideRevision, sections }) {
  const body = payload({ guide_revision: guideRevision, core_sha256: skillTextHash(core), sections });
  return validateWorkerGuidance({ ...body, sha256: skillTextHash(JSON.stringify(body)) }, core);
}
export function validateWorkerGuidance(value, core) {
  const snapshot = snapshotSchema.parse(value);
  if (snapshot.core_sha256 !== skillTextHash(core) || snapshot.sha256 !== skillTextHash(JSON.stringify(payload(snapshot))))
    throw new Error('Worker core and workflow snapshot do not match.');
  return snapshot;
}
export function readWorkerGuidance(stateDir, core = readPrivate(join(stateDir, 'instructions.md'))) {
  let value;
  try { value = readPrivate(join(stateDir, 'worker-guides.json'), true); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  return validateWorkerGuidance(value, core);
}
export function snapshotWorkerInstructions(sourceDir, stateDir) {
  // Existing mission instructions, including pre-router sessions with no reference
  // snapshot, remain untouched. Their consumer/removal boundary is that mission's end.
  if (lstatExists(join(stateDir, 'instructions.md'))) return;
  const core = readPrivate(join(sourceDir, 'instructions.md'));
  const guides = readWorkerGuidance(sourceDir, core);
  if (!guides) throw new Error('The new mission has no bundled workflow snapshot.');
  // The core commits the pair last, so interruption cannot expose a new core with
  // absent guides. A retry before that commit replaces only uncommitted preparation.
  writePrivate(join(stateDir, 'worker-guides.json'), guides);
  writePrivate(join(stateDir, 'instructions.md'), core);
}
