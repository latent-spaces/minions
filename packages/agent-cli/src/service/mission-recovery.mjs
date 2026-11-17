import { createHash } from 'node:crypto';
import { z } from 'zod/v4';
import { RuntimeError, validateTarget } from './contracts.mjs';

const id = z.string().min(1).max(256);
const base = { version:z.literal(1),operationId:z.uuid(),missionId:z.uuid(),generation:z.number().int().positive(),
  target:z.object({site:z.url().max(300),ownerId:id,projectId:id,agentId:id}).strict(),approved:z.literal(true),
  reason:z.string().trim().min(1).max(1000).refine(value=>Buffer.byteLength(value)<=4000 && !/[\x00-\x1f\x7f]/.test(value)) };
export const missionRecoverySchema = z.discriminatedUnion('action',[
  z.object({...base,action:z.literal('finalize')}).strict(),
  z.object({...base,action:z.literal('retry_report'),reportId:z.string().regex(/^[a-f0-9]{64}$/),
    expectedAttempts:z.number().int().nonnegative(),expectedErrorCode:z.string().regex(/^[A-Za-z0-9_:.-]{1,100}$/)}).strict(),
]);
export function validateMissionRecovery(input) {
  const parsed=missionRecoverySchema.safeParse(input);
  if(!parsed.success)throw new RuntimeError('invalid_command','Use the exact approved mission recovery action, identity and observed report fields.');
  validateTarget(parsed.data.target);return parsed.data;
}
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'
  ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
export function missionRecoveryFingerprint(input) {
  return createHash('sha256').update(JSON.stringify(canonical({kind:'mission_recovery',...validateMissionRecovery(input)}))).digest('hex');
}
export function settledExecution(mission) {
  const last=mission.outcomes.at(-1);
  return mission.guardPid===null && mission.currentTurnId===null && (!last || last.outcome.cleanupConfirmed===true && last.outcome.delivery!=='submitted');
}
export function assertRecoveryCheckout(checkout) {
  if(!checkout || !['observed','missing'].includes(checkout.status) || checkout.complete!==true
    || checkout.invalidRecords!==0 || !Array.isArray(checkout.exactClaims)
    || checkout.exactClaims.some(claim=>claim.cleanup!=='idle_recorded' || claim.owner!=='absent'))
    throw new RuntimeError('recovery_not_safe','Checkout cleanup is not confirmed. Preserve its claims and inspect the exact execution; no process was killed or ownership removed.');
}
