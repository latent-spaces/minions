import { createHash } from 'node:crypto';
import { validRunMinutes } from '../run-length.mjs';
import { z } from 'zod/v4';
import { RuntimeError, RUNTIME_LIMITS, validateTarget } from './contracts.mjs';

const target = z.object({ site: z.string(), ownerId: z.string(), projectId: z.string(), agentId: z.string() }).strict()
  .superRefine((value, context) => { try { validateTarget(value); } catch { context.addIssue({ code: 'custom', message: 'Invalid exact participation target.' }); } });
const time = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const grant = { approved: z.literal(true), approvedAt: time, deadlineAt: time };
const base = { version: z.literal(1), operationId: z.uuid(), target, participationId: z.uuid() };
const generation = z.number().int().positive();
export const participationCommandSchema = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('claim'), payload: z.object({ ...grant, scope: z.string().trim().min(1).max(RUNTIME_LIMITS.scopeBytes) }).strict() }).strict(),
  z.object({ ...base, kind: z.literal('extend'), generation, payload: z.object({ ...grant, expectedDeadlineAt: time }).strict() }).strict(),
  z.object({ ...base, kind: z.literal('release'), generation, payload: z.object({}).strict() }).strict(),
  z.object({ ...base, kind: z.literal('wake'), generation, payload: z.object({ ...grant, nextParticipationId: z.uuid() }).strict() }).strict(),
]);
export const participationQuerySchema = z.object({ target, participationId: z.uuid() }).strict();
export function validateParticipationCommand(value) {
  let command;
  try { command = participationCommandSchema.parse(value); }
  catch { throw new RuntimeError('invalid_command', 'Use the exact participation command and an explicitly approved lifetime.'); }
  if (command.kind !== 'release') {
    const { approvedAt, deadlineAt } = command.payload;
    // Existing saved work-setting bounds; no default duration or sliding lease.
    const duration = deadlineAt - (command.kind === 'extend' ? command.payload.expectedDeadlineAt : approvedAt);
    if (!validRunMinutes(duration / 60000))
      throw new RuntimeError('invalid_command', 'Choose an explicit lifetime of 5 minutes to 24 hours, in five-minute steps.');
    if (command.kind === 'claim' && Buffer.byteLength(command.payload.scope) > RUNTIME_LIMITS.scopeBytes)
      throw new RuntimeError('invalid_command', 'Participation scope exceeds its byte limit.');
  }
  return command;
}
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const participationFingerprint = command => createHash('sha256').update(JSON.stringify(canonical(validateParticipationCommand(command)))).digest('hex');
