import { z } from 'zod';
import { COMMUNICATION_BOUNDS } from '@minions/contracts';

export const SETUP_COMMUNICATION = z.object({
  defaults: z.object({ broadcastAllowed: z.boolean(),
    sendsPerHour: z.number().int().min(1).max(COMMUNICATION_BOUNDS.sendsPerHour),
    minimumGapSeconds: z.number().int().min(COMMUNICATION_BOUNDS.minimumGapSeconds).max(COMMUNICATION_BOUNDS.maximumGapSeconds),
    broadcastsPerHour: z.number().int().min(1).max(COMMUNICATION_BOUNDS.broadcastsPerHour),
  }).strict(),
  sharedBroadcastsPerHour: z.number().int().min(1).max(COMMUNICATION_BOUNDS.broadcastsPerHour),
}).strict();
// One person only (decision 10 November 2026): setup no longer plans a role. A plannedRole saved earlier in a
// project or proposal is dropped as it is read, so those records still read; nothing is deleted from storage.
export const SETUP_PLAN = z.preprocess(value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const { plannedRole: _retired, ...plan } = value as Record<string, unknown>;
  return plan;
}, z.object({ peopleNote: z.string().trim().max(1500), communication: SETUP_COMMUNICATION }).strict());
