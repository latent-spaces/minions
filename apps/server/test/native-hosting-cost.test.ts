import { HOSTING_LIMITS, parseArtifact, sha256 } from '@mlswarm/contracts';
import { reconcileHostingCleanup } from '../src/hosting/cleanup.js';
import type { HostingTransport } from '../src/hosting/transport.js';
import { beforeEach, expect, test } from 'vitest';
import { db, profiles } from '../src/firestore.js';
import { projects } from '../src/projects/records.js';
import { configureHosting, prepareHosting, readHosting } from '../src/hosting/service.js';
import { hostingState, initialHostingState } from '../src/hosting/records.js';
import { instrumentFirestoreWork, meter, work } from './firestore-work-meter.js';
import { resetEmulator, seed, TEST_PROJECT } from './helpers.js';
import { TransactionPrototype } from './store-prototypes.js';

beforeEach(resetEmulator);
test('hosting reads stay bounded with 5,000 unrelated agents; empty listener seed and CPU/memory are counted', async () => {
  const seeded = await seed({ profiles: [{ name: 'Hosting owner', email: 'owner@example.test' }] });
  const ownerId = seeded.personIds[0], person = { id: ownerId, ...(await profiles.doc(ownerId).get()).data()! };
  await projects.doc(TEST_PROJECT).update({ ownerProfileId: ownerId });
  await hostingState(TEST_PROJECT).set(initialHostingState());
  // Deliberately unrelated records: a hosting reader has no reason to touch an agent roster.
  for (let batch = 0; batch < 10; batch++) {
    const write = db.batch();
    for (let i = 0; i < 500; i++) write.set(db.doc(`projects/${TEST_PROJECT}/agents/unrelated-${batch}-${i}`), { syntheticUnrelatedRecord: true });
    await write.commit();
  }
  const restore = instrumentFirestoreWork(), measured = work(), start = performance.now(), cpu = process.cpuUsage(), memoryBefore = process.memoryUsage();
  try {
    await meter.run(measured, async () => {
      for (let i = 0; i < 20; i++) await readHosting(TEST_PROJECT, { kind: 'person', person }, undefined, () => 10000);
      await new Promise<void>((resolve, reject) => {
        const stop = db.collection(`projects/${TEST_PROJECT}/hosting`).limit(1).onSnapshot(() => { stop(); resolve(); }, reject);
      });
    });
    expect(measured.reads).toBe(80); // profile + project + primary state + empty-page minimum per read.
    expect(measured.writes).toBe(0); expect(measured.listenerSeeds).toBe(1); expect(measured.listenerSeedDocs).toBe(1);
    expect(measured.transactionAttempts).toBe(20); expect(measured.failedCalls).toBe(0);
    console.info('Native hosting control-reader logical work (not a cloud bill)', JSON.stringify({
      reads: 20, unrelatedAgents: 5000, measured, elapsedMs: performance.now() - start,
      cpuMicroseconds: process.cpuUsage(cpu), memoryBefore, memoryAfter: process.memoryUsage(),
      scope: 'Control reader + one primary-document watch seed. Auth HTTP/SSE renewal and active publication measured separately.',
    }));
    // Writer setup is outside this measured service cleanup round. No R2 billing is
    // inferred from the injected transport; native deletion has its own regression.
    const actor = { kind: 'person' as const, person };
    await configureHosting(TEST_PROJECT, actor, { clientRequestId: 'cost-policy', expectedRevision: 0, confirmPublic: true,
      mode: 'approval', approvers: [ownerId], submitters: [ownerId] }, () => 10000);
    const artifact = await parseArtifact({ version: 1, entry: 'index.html', files: [{ path: 'index.html', bytes: 1, sha256: await sha256('x'), mime: 'text/html; charset=utf-8' }] });
    const transport: HostingTransport = { command: async (_project, path, body) => path.startsWith('cleanup/')
      ? { candidateId: path.split('/')[1], scope: (body as { scope: string }).scope, done: true, deleted: 0 } : {}, upload: async () => {} };
    const candidate = await prepareHosting(TEST_PROJECT, actor, { clientRequestId: 'cost-upload', policyRevision: 1, manifest: artifact.manifest }, () => 10000, transport);
    const cleanupWork = work(), cleanupCpu = process.cpuUsage(), cleanupStart = performance.now(), cleanupMemory = process.memoryUsage();
    const result = await meter.run(cleanupWork, () => reconcileHostingCleanup(() => candidate.expiresAt + HOSTING_LIMITS.retirementGraceMs, transport));
    expect(result.releasedBytes).toBe(1); expect(cleanupWork.reads).toBe(7); expect(cleanupWork.committedWrites).toBe(7);
    expect(cleanupWork.transactionAttempts).toBe(2); expect(cleanupWork.failedCalls).toBe(0);
    const idleWork = work(); await meter.run(idleWork, () => reconcileHostingCleanup(() => candidate.expiresAt + HOSTING_LIMITS.retirementGraceMs + 1, transport));
    expect(idleWork.reads).toBe(1); expect(idleWork.writes).toBe(0); expect(idleWork.transactions).toBe(0);
    console.info('Native hosting global cleanup logical work (not a cloud bill)', JSON.stringify({ cleanupWork, idleWork,
      elapsedMs: performance.now() - cleanupStart, cpuMicroseconds: process.cpuUsage(cleanupCpu), memoryBefore: cleanupMemory, memoryAfter: process.memoryUsage(),
      scope: 'One due candidate, one cleanup transport command, then one empty global due query. R2 physical work is excluded here and measured in Worker tests.' }));
  } finally { restore(); }
});
test('busy build page projects summaries instead of fetching complete manifests', async () => {
  const seeded=await seed({profiles:[{name:'Busy owner',email:'busy@example.test'}]});const ownerId=seeded.personIds[0];
  await projects.doc(TEST_PROJECT).update({ownerProfileId:ownerId});
  const person={id:ownerId,...(await profiles.doc(ownerId).get()).data()!};
  const digest=await sha256('x');
  const artifact=await parseArtifact({version:1,entry:'index.html',files:[{path:'index.html',bytes:1,sha256:digest,mime:'text/html; charset=utf-8'},
    ...Array.from({length:1499},(_,i)=>({path:`assets/${'a'.repeat(120)}${String(i).padStart(4,'0')}.js`,bytes:1,sha256:digest,mime:'text/javascript; charset=utf-8'}))]});
  const {hostingCandidates}=await import('../src/hosting/records.js');
  const state={...initialHostingState(),candidates:20,reservedBytes:20*artifact.bytes};await hostingState(TEST_PROJECT).set(state);
  const batch=db.batch();for(let i=0;i<20;i++){const id=i.toString(16).padStart(64,'0');batch.set(hostingCandidates(TEST_PROJECT).doc(id),{id,projectId:TEST_PROJECT,actorKey:`person:${ownerId}`,profileId:ownerId,epoch:0,policyRevision:0,artifact,fileCount:1500,createdAt:i,expiresAt:999999999,submittedBy:{profileId:ownerId,name:'Busy owner',agentId:null},lastPublishedAt:null,readyAt:1,state:'ready'});}await batch.commit();
  const prototype=TransactionPrototype as unknown as Record<string,(...args:any[])=>any>, original=prototype.get;
  let fetchedBytes=0,fetchedDocuments=0;
  prototype.get=async function(...args:any[]){const result=await original.apply(this,args);if(Array.isArray(result?.docs))for(const row of result.docs)if(row.ref.parent.id==='hostingCandidates'){const data=row.data();expect(data.artifact?.manifest).toBeUndefined();fetchedBytes+=Buffer.byteLength(JSON.stringify(data));fetchedDocuments++;}return result;};
  const start=performance.now(),cpu=process.cpuUsage(),before=process.memoryUsage();
  try{const result=await readHosting(TEST_PROJECT,{kind:'person',person},undefined,()=>10000);expect(result.candidates).toHaveLength(20);expect(result.candidates[0].files).toBe(1500);expect(fetchedDocuments).toBe(20);expect(fetchedBytes).toBeLessThan(20000);
    console.info('Busy hosting summary projection',JSON.stringify({manifestBytes:Buffer.byteLength(JSON.stringify(artifact.manifest)),candidates:20,fetchedBytes,fetchedDocuments,elapsedMs:performance.now()-start,cpuMicroseconds:process.cpuUsage(cpu),memoryBefore:before,memoryAfter:process.memoryUsage()}));
  }finally{prototype.get=original;}
});
