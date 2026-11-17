import { z } from 'zod/v4';
import { RUNTIME_LIMITS, boundedText, validateTarget } from './contracts.mjs';

const id = z.string().min(1).max(RUNTIME_LIMITS.identifierBytes).refine(value => {
  try { boundedText(value, 'identifier', RUNTIME_LIMITS.identifierBytes); return true; } catch { return false; }
}, { message: 'Use a nonempty identifier within the shared byte limit.' });

// Site and owner come from the authenticated installation, never caller input.
export const publicTargetSchema = z.object({ projectId: id, agentId: id }).strict();
export function bindPublicTarget(principal, target) {
  return validateTarget({ site: principal.site, ownerId: principal.ownerId, ...publicTargetSchema.parse(target) });
}
