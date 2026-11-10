import express from 'express';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { HOSTING_LIMITS, artifactMime, parseArtifact, sha256, type HostingServingHead } from '@mlswarm/contracts';
import { hashToken, newToken } from '../src/auth.js';
import { inProject, profiles } from '../src/firestore.js';
import { ownerRoutes, computerConnections, ownerVerification } from '../src/owner/routes.js';
import { projectHostingAgentRoutes, projectHostingComputerRoutes, projectHostingRoutes } from '../src/hosting/routes.js';
import { configureHosting, prepareHosting, uploadHostingFile, sealHosting, requestHostingPublication, requestHostingUnpublish, applyHostingOperation, reconcileHostingOperations } from '../src/hosting/service.js';
import { hostingOperations, hostingCandidates } from '../src/hosting/records.js';
import type { HostingActor } from '../src/hosting/authority.js';
import { projects } from '../src/projects/records.js';
import { membershipDoc } from '../src/projects/access.js';
import { startRun } from '../src/v2/runs.js';
import { resetEmulator, seed, seedRuntime, TEST_PROJECT, idTokenFor } from './helpers.js';

let server: Server, provider: Server, base: string;
const now = () => Date.now();
const providerToken = 's'.repeat(48);
const manifests = new Map<string, Awaited<ReturnType<typeof parseArtifact>>>();
const uploaded = new Map<string, Set<number>>();
let head: HostingServingHead | null = null, uploads = 0, headWrites = 0, failHead = false, loseHeadReply = false;
let uploadGate: Promise<void> | undefined, sealGate: Promise<void> | undefined, sealCalls = 0;
const previous = { origin: process.env.HOSTING_CONTROL_ORIGIN, token: process.env.HOSTING_CONTROL_TOKEN };
beforeAll(async () => {
  const remote = express();
  remote.use('/control/:project/upload/:candidate/:index', express.raw({type:()=>true,limit:HOSTING_LIMITS.fileBytes}), (req, res) => {
    uploads++; void (async () => { await uploadGate; const key = String(req.params.candidate); const set = uploaded.get(key) ?? new Set(); set.add(Number(req.params.index)); uploaded.set(key,set); res.json({}); })();
  });
  remote.use(express.json({limit:HOSTING_LIMITS.manifestBytes}));
  remote.all('/control/:project/:action{/:candidate}', (req, res) => { void (async () => {
    if(req.headers.authorization !== `Bearer ${providerToken}`) { res.status(401).json({}); return; }
    const action = req.params.action, candidate = String(req.params.candidate);
    if(action === 'prepare') { const a=await parseArtifact(req.body.manifest);manifests.set(candidate,a);res.json({digest:a.digest});return; }
    if(action === 'status') { res.json({digest:manifests.get(candidate)!.digest,uploaded:[...(uploaded.get(candidate)??[])]});return; }
    if(action === 'seal') { sealCalls++;await sealGate;const a=manifests.get(candidate)!;res.json({digest:a.digest,bytes:a.bytes,sealed:true});return; }
    if(action === 'head' && req.method === 'GET') {res.json({head});return;}
    if(action === 'head') {
      if(failHead){res.status(503).json({});return;}
      headWrites++;
      const v=req.body;head={version:1,revision:(head?.revision??0)+1,generation:v.generation,operationId:v.operationId,
        intent:await sha256(JSON.stringify({operationId:v.operationId,generation:v.generation,artifact:v.artifact,candidateId:v.candidateId})),current:v.artifact,disabled:v.artifact===null,
        releases:v.artifact?[{artifact:v.artifact,buildId:v.candidateId,bytes:1,retiredAt:null}]:[]};if(loseHeadReply){loseHeadReply=false;res.status(503).json({});return;}res.json(head);return;
    }
    res.status(404).json({});
  })().catch(()=>res.status(500).json({})); });
  provider=remote.listen(0,'127.0.0.1');await new Promise<void>(r=>provider.once('listening',r));
  process.env.HOSTING_CONTROL_ORIGIN=`http://127.0.0.1:${(provider.address() as {port:number}).port}`;process.env.HOSTING_CONTROL_TOKEN=providerToken;
  const app=express();app.use('/api/owner/project-hosting',projectHostingComputerRoutes(now));app.use('/p/:projectId/v2/hosting',projectHostingAgentRoutes(now));
  app.use('/api/project-hosting',projectHostingRoutes(now));app.use('/api/owner',ownerRoutes(now));
  server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
});
afterAll(async()=>{await Promise.all([new Promise<void>(r=>server.close(()=>r())),new Promise<void>(r=>provider.close(()=>r()))]);
  if(previous.origin===undefined)delete process.env.HOSTING_CONTROL_ORIGIN;else process.env.HOSTING_CONTROL_ORIGIN=previous.origin;
  if(previous.token===undefined)delete process.env.HOSTING_CONTROL_TOKEN;else process.env.HOSTING_CONTROL_TOKEN=previous.token;
});
beforeEach(async()=>{await resetEmulator();manifests.clear();uploaded.clear();head=null;uploads=0;headWrites=0;failHead=false;loseHeadReply=false;uploadGate=undefined;sealGate=undefined;sealCalls=0;});
async function http(path:string,token?:string,body?:object|Uint8Array,extra:Record<string,string>={}) {
  const raw=body instanceof Uint8Array;const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{...(token?{Authorization:`Bearer ${token}`} : {}),'Content-Type':raw?'application/octet-stream':'application/json',...extra},...(body===undefined?{}:{body:raw?new Uint8Array(body):JSON.stringify(body)})});
  const text=await r.text();let value;try{value=JSON.parse(text);}catch{value=text;}return {status:r.status,body:value,headers:r.headers};
}
async function fixture(mode:'approval'|'automatic'='approval') {
  const seeded=await seed({profiles:[{name:'Owner',email:'owner@example.test'},{name:'Submitter',email:'submit@example.test'},{name:'Other',email:'other@example.test'}],agents:[{person:0,name:'Agent'}]});
  await projects.doc(TEST_PROJECT).update({ownerProfileId:seeded.personIds[0]});
  const firebase=await idTokenFor('owner@example.test'),token=newToken(),id=randomUUID();
  await http('/api/owner/connect',undefined,{requestId:id,pollingSecret:newToken(),candidateTokenHash:hashToken(token),clientName:'Hosting computer'});
  expect((await http(`/api/owner/connect/${id}/approve`,firebase,{approved:true})).status).toBe(200);
  const prefix=`/api/owner/project-hosting/${TEST_PROJECT}`;
  const settings={clientRequestId:'policy',expectedRevision:0,confirmPublic:true,mode,approvers:[seeded.personIds[0]],submitters:[seeded.personIds[0]]};
  expect((await http(prefix+'/policy',token,settings)).status).toBe(200);
  const data=new TextEncoder().encode('<!doctype html><title>Public game fixture</title>');
  const artifact=await parseArtifact({version:1,entry:'index.html',files:[{path:'index.html',bytes:data.length,sha256:await sha256(data),mime:artifactMime('index.html')}]});
  const owner={kind:'person' as const,person:{id:seeded.personIds[0],...(await profiles.doc(seeded.personIds[0]).get()).data()!}};
  const actor:HostingActor={...owner,computer:{connectionId:id,tokenHashDigest:hashToken(hashToken(token))}};
  const prepare=()=>http(prefix+'/candidates',token,{clientRequestId:'candidate',policyRevision:1,manifest:artifact.manifest});
  const ready=async()=>{const p=await prepare();expect(p.status).toBe(200);const candidate=p.body.candidateId;expect((await http(prefix+`/candidates/${candidate}/files/0`,token,data)).status).toBe(200);expect((await http(prefix+`/candidates/${candidate}/seal`,token,{})).body.state).toBe('ready');return candidate;};
  return {seeded,firebase,token,id,prefix,settings,data,artifact,owner,actor,prepare,ready};
}

test('computer-only ingress uploads on a paused project and requires exact person approval',async()=>{
  const f=await fixture();await seedRuntime(TEST_PROJECT,{paused:true});
  const candidate=await f.ready();expect(head).toBeNull();
  const publication=await http(f.prefix+'/publications',f.token,{clientRequestId:'publish',candidateId:candidate,policyRevision:1});
  expect(publication.status).toBe(200);expect(publication.body.state).toBe('published');expect(head?.current).toBe(f.artifact.digest);
  const op=(await hostingOperations(TEST_PROJECT).doc(publication.body.id).get()).data()!;expect(op.computerConnection).toEqual(f.actor.kind==='person'?f.actor.computer:undefined);expect(op.connection).toBeNull();
});

test('ordinary sign-in, changed account headers, revoked computers and lost membership cannot upload',async()=>{
  const f=await fixture();const body={clientRequestId:'candidate',policyRevision:1,manifest:f.artifact.manifest};
  expect((await http(f.prefix+'/candidates',f.firebase,body)).status).toBe(401);
  expect((await http(f.prefix+'/candidates',undefined,body)).status).toBe(401);
  expect((await http(f.prefix+'/candidates',f.token,body,{'X-Mlswarm-Profile-Id':f.seeded.personIds[1]})).status).toBe(401);
  expect((await http(`/api/project-hosting/${TEST_PROJECT}/candidates`,f.firebase,body)).status).toBe(404);
  await projects.doc(TEST_PROJECT).update({ownerProfileId:f.seeded.personIds[1]});
  await membershipDoc(TEST_PROJECT,f.seeded.personIds[0]).update({status:'removed'});expect((await f.prepare()).status).toBe(401);
  await membershipDoc(TEST_PROJECT,f.seeded.personIds[0]).update({status:'active'});await computerConnections.doc(f.id).update({revokedAt:now()});expect((await f.prepare()).status).toBe(401);
});

test('owner status alone grants no submission and only owner configures; closed projects reject uploads',async()=>{
  const f=await fixture();
  await configureHosting(TEST_PROJECT,f.owner,{...f.settings,clientRequestId:'different-submitters',expectedRevision:1,submitters:[f.seeded.personIds[1]]},now);
  await expect(prepareHosting(TEST_PROJECT,f.actor,{clientRequestId:'no-grant',policyRevision:2,manifest:f.artifact.manifest},now)).rejects.toMatchObject({code:'forbidden'});
  const member:HostingActor={kind:'person',person:{id:f.seeded.personIds[1],...(await profiles.doc(f.seeded.personIds[1]).get()).data()!}};
  await expect(configureHosting(TEST_PROJECT,member,{...f.settings,expectedRevision:2},now)).rejects.toMatchObject({code:'forbidden'});
  await configureHosting(TEST_PROJECT,f.owner,{...f.settings,clientRequestId:'owner-restored',expectedRevision:2},now);
  await seedRuntime(TEST_PROJECT,{completedAt:now(),paused:true});await expect(prepareHosting(TEST_PROJECT,f.actor,{clientRequestId:'closed',policyRevision:3,manifest:f.artifact.manifest},now)).rejects.toMatchObject({code:'forbidden'});
});

test('revocation/expiry/token rotation fence every upload phase and delayed automatic recovery',async()=>{
  const f=await fixture('automatic');const candidate=await f.ready();
  const op=await requestHostingPublication(TEST_PROJECT,f.actor,{clientRequestId:'publish',policyRevision:1,candidateId:candidate},now);
  failHead=true;expect((await applyHostingOperation(TEST_PROJECT,f.actor,op.id,now)).state).toBe('uncertain');
  await computerConnections.doc(f.id).update({revokedAt:now()});failHead=false;
  const result=await reconcileHostingOperations(now);expect(result.retried).toBe(1);expect(headWrites).toBe(0);expect(head).toBeNull();
  await expect(uploadHostingFile(TEST_PROJECT,f.actor,candidate,0,Buffer.from(f.data),now)).rejects.toMatchObject({code:'unauthorized'});
  await computerConnections.doc(f.id).update({revokedAt:null,connectionExpiresAt:now()-1});await expect(sealHosting(TEST_PROJECT,f.actor,candidate,now)).rejects.toMatchObject({code:'unauthorized'});
  await computerConnections.doc(f.id).update({connectionExpiresAt:now()+100000,candidateTokenHash:hashToken(newToken())});await expect(prepareHosting(TEST_PROJECT,f.actor,{clientRequestId:'other',policyRevision:1,manifest:f.artifact.manifest},now)).rejects.toMatchObject({code:'unauthorized'});
});

test('computer file ingress enforces byte limits before provider upload',async()=>{
  const f=await fixture();const p=await f.prepare();const response=await http(f.prefix+`/candidates/${p.body.candidateId}/files/0`,f.token,new Uint8Array(HOSTING_LIMITS.fileBytes+1));expect(response.status).toBe(413);expect(uploads).toBe(0);
});


test('computer and agent file uploads share the same two outstanding-provider slots',async()=>{
  const f=await fixture();const registered=f.seeded.agents[0];
  const run=await inProject(TEST_PROJECT,()=>startRun(registered.agentId,{clientRunId:randomUUID(),runnerVersion:'synthetic-no-model',takeover:false},now));
  const agentPrefix=`/p/${TEST_PROJECT}/v2/hosting`,headers={'x-pilot-run':run.run_id};
  const agentCandidate=await http(agentPrefix+'/candidates',registered.token,{clientRequestId:'agent-candidate',policyRevision:1,manifest:f.artifact.manifest},headers);expect(agentCandidate.status).toBe(200);
  const computerCandidate=await f.prepare();expect(computerCandidate.status).toBe(200);
  let release!:()=>void;uploadGate=new Promise<void>(resolve=>{release=resolve;});
  const first=http(f.prefix+`/candidates/${computerCandidate.body.candidateId}/files/0`,f.token,f.data);
  const second=http(agentPrefix+`/candidates/${agentCandidate.body.candidateId}/files/0`,registered.token,f.data,headers);
  try {
    const until=Date.now()+5000;while(uploads<2&&Date.now()<until)await new Promise(r=>setTimeout(r,20));expect(uploads).toBe(2);
    const third=await http(f.prefix+`/candidates/${computerCandidate.body.candidateId}/files/0`,f.token,f.data);
    expect(third.status).toBe(429);expect(third.headers.get('retry-after')).toBe('1');expect(uploads).toBe(2);
  } finally {release();expect((await Promise.all([first,second])).map(x=>x.status)).toEqual([200,200]);}
});


test('a committed lost acknowledgement can be observed after computer revocation without another publication',async()=>{
  const f=await fixture('automatic');const candidate=await f.ready();const op=await requestHostingPublication(TEST_PROJECT,f.actor,{clientRequestId:'publish',policyRevision:1,candidateId:candidate},now);
  loseHeadReply=true;expect((await applyHostingOperation(TEST_PROJECT,f.actor,op.id,now)).state).toBe('uncertain');expect(headWrites).toBe(1);
  await computerConnections.doc(f.id).update({revokedAt:now()});
  expect((await applyHostingOperation(TEST_PROJECT,f.owner,op.id,now)).state).toBe('published');expect(headWrites).toBe(1);
});


test('accepted computer takedown remains recoverable after closure and computer revocation',async()=>{
  const f=await fixture();const candidate=await f.ready();const publication=await requestHostingPublication(TEST_PROJECT,f.actor,{clientRequestId:'publish',policyRevision:1,candidateId:candidate},now);await applyHostingOperation(TEST_PROJECT,f.actor,publication.id,now);
  await seedRuntime(TEST_PROJECT,{completedAt:now(),paused:true});
  const stop=await requestHostingUnpublish(TEST_PROJECT,f.actor,{clientRequestId:'stop'},now);expect(stop.computerConnection).toEqual(f.actor.kind==='person'?f.actor.computer:undefined);
  failHead=true;expect((await applyHostingOperation(TEST_PROJECT,f.actor,stop.id,now)).state).toBe('uncertain');
  await computerConnections.doc(f.id).update({revokedAt:now()});failHead=false;
  expect((await reconcileHostingOperations(now)).failed).toBe(0);expect(head?.disabled).toBe(true);expect((await hostingOperations(TEST_PROJECT).doc(stop.id).get()).data()?.state).toBe('unpublished');
});


test('owner API and computer hosting share the same bounded expensive-verification budget',async()=>{
  const f=await fixture();let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  const occupied=Array.from({length:32},()=>ownerVerification(async()=>{await gate;}));
  try {
    const computer=await http(f.prefix,f.token),owner=await http(`/api/owner/projects/${TEST_PROJECT}/overview`,f.token);
    expect(computer.status).toBe(429);expect(owner.status).toBe(429);
    expect(computer.headers.get('retry-after')).toBe('1');expect(owner.headers.get('retry-after')).toBe('1');
  } finally {release();await Promise.all(occupied);}
  expect((await http(f.prefix,f.token)).status).toBe(200);
  expect((await http(`/api/owner/projects/${TEST_PROJECT}/overview`,f.token)).status).toBe(200);
});


test('project closure during provider sealing cannot commit a ready candidate',async()=>{
  const f=await fixture();const prepared=await f.prepare(),candidate=prepared.body.candidateId;
  expect((await http(f.prefix+`/candidates/${candidate}/files/0`,f.token,f.data)).status).toBe(200);
  let release!:()=>void;sealGate=new Promise<void>(resolve=>{release=resolve;});
  const pending=http(f.prefix+`/candidates/${candidate}/seal`,f.token,{});
  try {
    const until=Date.now()+5000;while(sealCalls===0&&Date.now()<until)await new Promise(r=>setTimeout(r,20));expect(sealCalls).toBe(1);
    await seedRuntime(TEST_PROJECT,{completedAt:now(),paused:true});
  } finally {release();}
  expect((await pending).status).toBe(403);expect((await hostingCandidates(TEST_PROJECT).doc(candidate).get()).data()?.state).toBe('uploading');expect(head).toBeNull();
});
