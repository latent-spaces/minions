import type { Transaction } from '../firestore.js';
import { db } from '../firestore.js';
import { Refusal } from '../errors.js';
import { CURRENT_STATE_CUTOVER_RECEIPT, CURRENT_STATE_PROGRESS_EPOCH, USAGE_EPOCH } from '../storage/schema.js';
export { CURRENT_STATE_CUTOVER_RECEIPT };

// One-way operator attestation, created only after old writers have drained and
// complete live coverage has passed, or by explicit initialization of a new empty standalone
// store whose writers all use the current schema. No runtime writer creates or repairs it.
// Historical records need no migration. This is an admission barrier, never a
// selector between reader implementations. Missing/invalid evidence fails closed.
export async function requireCurrentStateCutover(tx: Transaction): Promise<string> {
  const receipt = await tx.get(db.doc(CURRENT_STATE_CUTOVER_RECEIPT));
  const data = receipt.data();
  if (data?.schema !== 2 || data?.epoch !== CURRENT_STATE_PROGRESS_EPOCH || data?.usageEpoch !== USAGE_EPOCH
    || typeof data?.writerSource !== 'string' || !/^[a-f0-9]{40}$/.test(data.writerSource)
    || typeof data?.evidenceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(data.evidenceSha256))
    throw new Refusal('project_busy', 'Project status is temporarily unavailable. Try again shortly.', 2);
  return `${receipt.updateTime!.seconds}.${receipt.updateTime!.nanoseconds}`;
}
