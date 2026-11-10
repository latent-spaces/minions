import { createHash } from 'node:crypto';
import type { Transaction } from '../firestore.js';
import { projectCollection } from '../firestore.js';
import { USAGE_EPOCH } from '../storage/schema.js';
export { USAGE_EPOCH };

export const USAGE_SHARDS = 16;
export type UsageProgress = { schema: 1; epoch: string; revision: number; usageRevision: number; created: number };
export const usageProgress = () => projectCollection<UsageProgress>('usageProgress');
export const usageChanges = () => projectCollection<{ schema: 1; epoch: string; shard: string; revision: number }>('usageChanges');
export const usageShard = (id: string) => String(createHash('sha256').update(id).digest()[0]! % USAGE_SHARDS).padStart(2, '0');
const safe = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
export const validUsageProgress = (data: UsageProgress | undefined): data is UsageProgress => Boolean(data && data.schema === 1 && data.epoch === USAGE_EPOCH
  && safe(data.revision) && safe(data.usageRevision) && data.usageRevision <= data.revision && safe(data.created));

// Prepare before ANY writes, attempt-local. Report retries/replays cannot allocate
// a proof without their usage mutation. Creation counters include revoked agents.
export async function prepareUsageProgress(tx: Transaction, ids: string[]) {
  const selected = new Set(ids), refs = [...new Set(ids.map(usageShard))].map(id => usageProgress().doc(id));
  const docs = refs.length ? await tx.getAll(...refs) : [];
  const states = new Map(docs.map(doc => {
    const data = doc.data();
    if (data && !validUsageProgress(data)) throw new Error('Usage progress requires a reviewed forward epoch.');
    if (data && (data.revision >= Number.MAX_SAFE_INTEGER || data.created >= Number.MAX_SAFE_INTEGER - ids.length))
      throw new Error('Usage progress counter exhausted.');
    return [doc.id, { schema: 1 as const, epoch: USAGE_EPOCH, revision: (data?.revision ?? 0) + 1,
      usageRevision: data?.usageRevision ?? 0, created: data?.created ?? 0 }];
  }));
  const created = new Set<string>();
  return (id: string, kind: 'usage' | 'created') => {
    if (!selected.has(id)) throw new Error('Usage mutation was not prepared before writes.');
    const shard = usageShard(id), state = states.get(shard)!;
    if (kind === 'created' && !created.has(id)) { created.add(id); state.created++; }
    if (kind === 'usage') {
      state.usageRevision = state.revision;
      tx.set(usageChanges().doc(id), { schema: 1, epoch: USAGE_EPOCH, shard, revision: state.revision });
    }
    tx.set(usageProgress().doc(shard), { ...state });
  };
}
