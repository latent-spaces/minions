// One snapshot-isolated transaction proves progress and reads the corresponding heads.
// No listener callback or elapsed timer grants currentness. The writer protocol is a release precondition.
import { type QuerySnapshot, type Timestamp, type Transaction, type DocumentSnapshot } from '../firestore.js';
import { currentProjectId, db } from '../firestore.js';
import { presence } from '../v2/records.js';
import { CURRENT_STATE_PROGRESS_SHARDS, CURRENT_STATE_PROGRESS_EPOCH, CURRENT_STATE_PROGRESS_SCHEMA } from './current-state-progress.js';
import { requireCurrentStateCutover } from './current-state-cutover.js';

export type ProgressFence = { vector: string; revisions: number[]; readTime: Timestamp; active: boolean; epoch: string; readiness: string };
export const progressReadStats = { fences: 0, fenceDocs: 0, fenceErrors: 0, changes: 0, changeDocs: 0,
  rowReads: 0, rowDocs: 0, deltaErrors: 0, canonicalReads: 0, canonicalDocs: 0, tombstoneDocs: 0, refreshAttempts: 0, readinessReads: 0 };
export function resetProgressReadStats() {
  for (const key of Object.keys(progressReadStats) as (keyof typeof progressReadStats)[]) progressReadStats[key] = 0;
}
const root = () => db.collection('projects').doc(currentProjectId());
async function fence(tx: Transaction): Promise<ProgressFence> {
  progressReadStats.fences++;
  progressReadStats.readinessReads++;
  const readiness = await requireCurrentStateCutover(tx);
  const shards = await tx.get(root().collection('currentStateProgress').limit(CURRENT_STATE_PROGRESS_SHARDS + 1));
  progressReadStats.fenceDocs += Math.max(1, shards.size);
  const epoch = CURRENT_STATE_PROGRESS_EPOCH;
  let active = shards.size <= CURRENT_STATE_PROGRESS_SHARDS;
  const revisions = Array<number>(CURRENT_STATE_PROGRESS_SHARDS).fill(0);
  const versions: string[] = [readiness];
  for (const shard of shards.docs) {
    const data = shard.data(), n = Number(shard.id);
    if (!/^(0[0-9]|1[0-5])$/.test(shard.id) || data.schema !== CURRENT_STATE_PROGRESS_SCHEMA || data.epoch !== epoch
      || !Number.isSafeInteger(data.revision) || data.revision < 0) { active = false; continue; }
    revisions[n] = data.revision;
    // A reset to the same counter value is never mistaken for equality. The fixed epoch cannot be reset in place.
    versions.push(`${shard.id}:${shard.updateTime.seconds}.${shard.updateTime.nanoseconds}`);
  }
  return { vector: JSON.stringify([epoch, revisions, versions]), revisions, readTime: shards.readTime, active, epoch, readiness };
}
export async function readCurrentStateProgress(): Promise<ProgressFence> {
  try { return await db.runTransaction(fence, { readOnly: true }); }
  catch (error) { progressReadStats.fenceErrors++; throw error; }
}
async function delta(tx: Transaction, previous: ProgressFence, current: ProgressFence): Promise<QuerySnapshot> {
  const changed = current.revisions.flatMap((revision, n) => revision > previous.revisions[n]! ? [n] : []);
  progressReadStats.changes += changed.length;
  const queries = await Promise.all(changed.map(n => tx.get(root().collection('currentStateChanges')
    .where('shard', '==', String(n).padStart(2, '0')).where('revision', '>', previous.revisions[n]!))));
  const dirty = queries.flatMap(query => query.docs);
  progressReadStats.changeDocs += queries.reduce((n, query) => n + Math.max(1, query.size), 0);
  const rows: { type: 'modified' | 'removed'; doc: DocumentSnapshot | { id: string; updateTime: Timestamp } }[] = [];
  for (let start = 0; start < dirty.length; start += 500) {
    const docs = dirty.slice(start, start + 500);
    progressReadStats.rowReads++; progressReadStats.rowDocs += docs.length;
    const states = await tx.getAll(...docs.map(doc => presence().doc(doc.id)));
    for (let n = 0; n < states.length; n++) {
      const state = states[n]!, change = docs[n]!;
      rows.push(state.exists ? { type: 'modified', doc: state }
        : { type: 'removed', doc: { id: state.id, updateTime: change.updateTime } });
    }
  }
  return { size: dirty.length, readTime: current.readTime, docChanges: () => rows } as unknown as QuerySnapshot;
}
async function canonical(tx: Transaction): Promise<QuerySnapshot> {
  progressReadStats.canonicalReads++;
  const [states, dirty] = await Promise.all([tx.get(presence()), tx.get(root().collection('currentStateChanges'))]);
  progressReadStats.canonicalDocs += Math.max(1, states.size);
  progressReadStats.tombstoneDocs += Math.max(1, dirty.size);
  const live = new Set(states.docs.map(doc => doc.id));
  const removed = dirty.docs.filter(doc => !live.has(doc.id)).map(doc => ({ type: 'removed' as const,
    doc: { id: doc.id, updateTime: doc.updateTime } }));
  return { docs: states.docs, size: states.size, readTime: states.readTime,
    docChanges: () => [...states.docChanges(), ...removed] } as unknown as QuerySnapshot;
}

export async function readCurrentStateRefresh(previous?: ProgressFence) {
  try {
    return await db.runTransaction(async tx => {
      progressReadStats.refreshAttempts++;
      const current = await fence(tx);
      if (!current.active) return { fence: current, snapshot: null, full: false };
      if (previous?.vector === current.vector) return { fence: current, snapshot: null, full: false };
      const full = !previous || previous.readiness !== current.readiness || previous.epoch !== current.epoch
        || current.revisions.some((revision, n) => revision < previous.revisions[n]!);
      let snapshot = full ? await canonical(tx) : await delta(tx, previous!, current);
      // A vector advance with zero dirty records is a contract violation, never proof that nothing changed.
      // Read the canonical input in this SAME transaction so recovery still has one coherent read point.
      const recover = !full && snapshot.size === 0;
      if (recover) snapshot = await canonical(tx);
      return { fence: current, snapshot, full: full || recover };
    }, { readOnly: true });
  } catch (error) { progressReadStats.deltaErrors++; throw error; }
}
