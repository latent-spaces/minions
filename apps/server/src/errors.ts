import type { Response } from 'express';

export type RefusalCode =
  | 'tasks_disabled' | 'teams_disabled' | 'unauthorized' | 'forbidden' | 'not_started' | 'paused' | 'rate_limited'
  | 'too_long'
  | 'not_found' | 'duplicate' | 'bad_input'
  | 'image_rejected' | 'moderation_unavailable' | 'moderation_required'
  | 'intent_conflict' | 'recipient_backlog' | 'project_busy' | 'run_active' | 'run_superseded' | 'runtime_conflict' | 'proposal_conflict' | 'proposal_state' | 'delivery_conflict' | 'limit_reached';

// An expected refusal, with a message written for the agent or person to read.
// Any other thrown error is a bug. retryAfterSeconds is set when waiting helps.
export class Refusal extends Error {
  constructor(public code: RefusalCode, message: string, public retryAfterSeconds?: number, public limit?: LimitDetails) {
    super(message);
  }
}
// A capacity limit was reached. Retrying the same request cannot succeed until something changes.
export type LimitDetails = { scope: 'agents_per_participant' | 'private_participants'; limit: number; used: number };
export const limitReached = (limit: LimitDetails, message: string) => new Refusal('limit_reached', message, undefined, limit);
// Extra response fields for a refusal; a limit refusal says which limit and that retrying will not help.
export const refusalDetails = (error: Refusal) => error.limit ? { limit: error.limit, retryable: false } : {};

// One HTTP status per refusal code; every router answers a refusal the same way.
const REFUSAL_STATUS: Record<RefusalCode, number> = {
  bad_input: 400, too_long: 400, not_started: 400, paused: 400, recipient_backlog: 400,
  unauthorized: 401, forbidden: 403, not_found: 404,
  duplicate: 409, intent_conflict: 409, proposal_conflict: 409, proposal_state: 409, delivery_conflict: 409, limit_reached: 409,
  tasks_disabled: 409, teams_disabled: 409, moderation_required: 409, run_active: 409, run_superseded: 409, runtime_conflict: 409,
  image_rejected: 422, rate_limited: 429, moderation_unavailable: 503, project_busy: 503,
};
export const refusalStatus = (code: RefusalCode) => REFUSAL_STATUS[code];
// Writes a refusal: Retry-After when waiting helps, limit details, then any route-specific fields.
export function sendRefusal(res: Response, error: Refusal, extra: Record<string, unknown> = {}) {
  if (error.retryAfterSeconds !== undefined) res.set('Retry-After', String(error.retryAfterSeconds));
  res.status(REFUSAL_STATUS[error.code]).json({ error: error.code, message: error.message, ...refusalDetails(error), ...extra });
}
