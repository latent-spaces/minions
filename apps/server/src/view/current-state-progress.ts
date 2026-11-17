import { createHash } from 'node:crypto';
import { type DocumentReference, type Transaction } from '../firestore.js';
import { db } from '../firestore.js';
import { CURRENT_STATE_PROGRESS_SCHEMA, CURRENT_STATE_PROGRESS_EPOCH } from '../storage/schema.js';
export { CURRENT_STATE_PROGRESS_SCHEMA, CURRENT_STATE_PROGRESS_EPOCH };

// A sequence is allocated by reading its shard before ANY writes. Firestore serializes concurrent writers
// on that read; every changed agent and its shard are committed atomically. Timestamp selectors are unsound:
// REQUEST_TIME is not a reliable replay boundary for a document commit revision.
export const CURRENT_STATE_PROGRESS_SHARDS = 16;
export type CurrentStateProgress = (source: DocumentReference) => void;
export function currentStateProgressShard(agentId: string): string {
  return String(createHash('sha256').update(agentId).digest()[0]! % CURRENT_STATE_PROGRESS_SHARDS).padStart(2, '0');
}
function namespace(source: DocumentReference) {
  const match = /^projects\/([a-f0-9]{64})\/presence\/([A-Za-z0-9_-]{1,200})$/.exec(source.path);
  if (!match) throw new Error('Current-state progress requires a project status reference.');
  return { base: `projects/${match[1]}`, id: match[2]!, shard: currentStateProgressShard(match[2]!) };
}
export const progressWriteStats = { preparations: 0, shardReads: 0, dirtyWrites: 0, shardWrites: 0 };
export function resetProgressWriteStats() {
  for (const key of Object.keys(progressWriteStats) as (keyof typeof progressWriteStats)[]) progressWriteStats[key] = 0;
}
// Capture only this callback attempt's reads. SDK retries can reuse Transaction objects; no WeakMap or global
// per-transaction deduplication may suppress a retry's writes. Multiple agents on the same shard in one transaction
// deliberately share a sequence. Readers compare >previous, never assume one increment means one changed agent.
export async function prepareCurrentStateProgress(tx: Transaction, sources: DocumentReference[]): Promise<CurrentStateProgress> {
  progressWriteStats.preparations++;
  const selected = new Map(sources.map(source => [source.path, namespace(source)]));
  const refs = [...new Set([...selected.values()].map(s => `${s.base}/currentStateProgress/${s.shard}`))].map(path => db.doc(path));
  progressWriteStats.shardReads += refs.length;
  const shards = refs.length ? await tx.getAll(...refs) : [];
  const revisions = new Map(shards.map(doc => {
    const data = doc.data();
    if (data && (data.schema !== CURRENT_STATE_PROGRESS_SCHEMA || data.epoch !== CURRENT_STATE_PROGRESS_EPOCH
      || !Number.isSafeInteger(data.revision) || data.revision < 0 || data.revision >= Number.MAX_SAFE_INTEGER))
      throw new Error('Canonical current-state progress needs a new reviewed schema epoch.');
    return [doc.ref.path, (data?.revision ?? 0) + 1] as const;
  }));
  return source => {
    const s = selected.get(source.path);
    if (!s) throw new Error('Status write was not prepared before the transaction writes.');
    const shardPath = `${s.base}/currentStateProgress/${s.shard}`;
    const revision = revisions.get(shardPath)!;
    tx.set(db.doc(`${s.base}/currentStateChanges/${s.id}`), {
      schema: CURRENT_STATE_PROGRESS_SCHEMA, epoch: CURRENT_STATE_PROGRESS_EPOCH, shard: s.shard, revision,
    });
    tx.set(db.doc(shardPath), { schema: CURRENT_STATE_PROGRESS_SCHEMA, epoch: CURRENT_STATE_PROGRESS_EPOCH, revision });
    progressWriteStats.dirtyWrites++; progressWriteStats.shardWrites++;
  };
}
export function deleteCurrentStateSource(tx: Transaction, source: DocumentReference, progress: CurrentStateProgress): void {
  progress(source); tx.delete(source);
}
