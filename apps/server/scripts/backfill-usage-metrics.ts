// Bounded, idempotent derived-data backfill. Never edits receipts or deletes markers.
import { pathToFileURL } from 'node:url';
import { inProject } from '../src/firestore.js';
import { backfillUsageMetrics, METRICS_VERSION } from '../src/analytics/projection.js';
export async function backfillProjectUsage(projectId:string,after?:string,version=METRICS_VERSION) {
  if(!/^[a-f0-9]{64}$/.test(projectId) || after!==undefined&&!/^[a-f0-9]{64}$/.test(after)) throw new Error('Use an exact project ID and optional receipt cursor.');
  return inProject(projectId,()=>backfillUsageMetrics(after,Date.now,version));
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url) {
  const [projectId,...args]=process.argv.slice(2);let after:string|undefined,version=METRICS_VERSION;
  const seen=new Set();
  for(let i=0;i<args.length;i+=2){const flag=args[i],value=args[i+1];if(!value||seen.has(flag)||!['--after','--version'].includes(flag!))throw new Error('Use PROJECT_ID [--after RECEIPT_ID] [--version N].');seen.add(flag);if(flag==='--after')after=value;else {if(!/^[1-9][0-9]{0,2}$/.test(value))throw new Error('Use projection version 1–999.');version=Number(value);}}
  if(!projectId)throw new Error('Use PROJECT_ID [--after RECEIPT_ID] [--version N].');
  console.log(JSON.stringify(await backfillProjectUsage(projectId,after,version)));
}
