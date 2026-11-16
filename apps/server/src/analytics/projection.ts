import { createHash } from 'node:crypto';
import { FieldPath } from '../firestore.js';
import { collection, db, currentProjectId } from '../firestore.js';
import { turnReceipts } from '../v2/records.js';
import { emptyValues, mergeValues, turnValues } from './values.js';
import type { AnalyticsValues } from '@minions/contracts';
export const METRICS_VERSION = 1;
export type MetricsBucket = AnalyticsValues & {schema:1;day:string;projectId:string;provider:string;model:string|null;projectedAt:number};
const namespace=(kind:string,version:number)=>{if(!Number.isSafeInteger(version)||version<1||version>999)throw new Error('Invalid metrics projection version.');return `usageMetrics${kind}V${version}`;};
export const metricsBuckets=(version=METRICS_VERSION)=>collection<MetricsBucket>(namespace('',version));
type Pending={receiptPath:string;nextAt:number;projectId:string};
export const metricsPending=(version=METRICS_VERSION)=>collection<Pending>(namespace('Pending',version));
const markers=(version=METRICS_VERSION)=>collection<{receiptPath:string;projectedAt:number}>(namespace('Applied',version));
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const metricsJob=(receiptPath:string,at:number,version=METRICS_VERSION)=>({ref:metricsPending(version).doc(hash(receiptPath)),data:{receiptPath,nextAt:at,projectId:receiptPath.split('/')[1]!}});
export async function projectReceipt(receiptPath:string,at:number,version=METRICS_VERSION) {
  const match=/^projects\/([a-f0-9]{64})\/turnReports\/([a-f0-9]{64})$/.exec(receiptPath);
  if(!match) throw new Error('Invalid metrics receipt path.');
  const projectId=match[1]!, marker=markers(version).doc(hash(receiptPath)), pending=metricsJob(receiptPath,at,version).ref;
  return db.runTransaction(async tx=>{
    const [receipt,applied]=await Promise.all([tx.get(db.doc(receiptPath)),tx.get(marker)]);
    if(applied.exists) {tx.delete(pending);return false;}
    if(!receipt.exists) throw new Error('Missing metrics receipt.');
    const data=receipt.data()!, turn=data.lastTurn as Parameters<typeof turnValues>[0];
    if(!Number.isFinite(turn.endedAt)||turn.endedAt<0) throw new Error('Invalid completion time.');
    const day=new Date(turn.endedAt).toISOString().slice(0,10), provider=turn.usage?.provider??'unknown', model=turn.usage?.model??null;
    const ref=metricsBuckets(version).doc(hash([projectId,day,provider,model])), old=await tx.get(ref);
    const values=mergeValues(old.exists ? old.data()! : emptyValues(),turnValues(turn));
    tx.set(ref,{...values,schema:1,day,projectId,provider,model,projectedAt:at});
    tx.create(marker,{receiptPath,projectedAt:at});tx.delete(pending);return true;
  });
}
/** Bounded retryable work on the existing private scheduler. Receipt acceptance never waits for projection. */
export async function reconcileUsageMetrics(now:()=>number) {
  const at=now(), pending=await metricsPending().where('nextAt','<=',at).orderBy('nextAt').limit(40).get();
  let applied=0,failed=0;
  for(const job of pending.docs) {
    try { if(await projectReceipt(job.data().receiptPath,at)) applied++; }
    catch { failed++;await job.ref.update({nextAt:at+60_000}); }
  }
  return {selected:pending.size,applied,failed};
}
/** Explicit bounded history backfill. Repeating pages is safe; markers are retained. */
export async function backfillUsageMetrics(after?:string, now:()=>number=Date.now,version=METRICS_VERSION) {
  namespace('',version);
  let query=turnReceipts().orderBy(FieldPath.documentId()).limit(100);
  if(after) query=query.startAfter(after);
  const receipts=await query.get();
  for(const receipt of receipts.docs) await projectReceipt(`projects/${currentProjectId()}/turnReports/${receipt.id}`,now(),version);
  return {version,processed:receipts.size,next:receipts.size===100 ? receipts.docs.at(-1)!.id : null};
}
