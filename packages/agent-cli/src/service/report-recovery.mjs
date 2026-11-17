import { z } from 'zod/v4';
import { createHash } from 'node:crypto';
import { validateTarget, RuntimeError } from './contracts.mjs';

const id = z.string().min(1).max(256);
export const archiveReportSchema = z.object({
  version: z.literal(1),
  operationId: z.uuid(),
  missionId: z.uuid(),
  target: z.object({ site: z.url().max(300), ownerId: id, projectId: id, agentId: id }).strict(),
  reportId: z.string().regex(/^[a-f0-9]{64}$/),
  expectedErrorCode: z.enum(['run_superseded', 'bad_input']),
  approved: z.literal(true),
  reason: z.string().min(1).max(1000).refine(text =>
    text.trim().length > 0 && Buffer.byteLength(text) <= 4000 && !/[\x00-\x1f\x7f]/.test(text)),
}).strict();

export function validateArchiveReport(input) {
  const result = archiveReportSchema.safeParse(input);
  if (!result.success) throw new RuntimeError('invalid_command', 'Use the exact approved failed-launch report recovery fields.');
  validateTarget(result.data.target);
  return result.data;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

export function archiveReportFingerprint(input) {
  const command = { kind: 'archive_failed_launch_report', ...validateArchiveReport(input) };
  return createHash('sha256').update(JSON.stringify(canonical(command))).digest('hex');
}
