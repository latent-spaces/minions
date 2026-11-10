import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createOwnerClient } from '../src/owner-client.mjs';
import { inspectProjectOutput, PROJECT_OUTPUT_TOOL } from '../src/project-output.mjs';
import { digest } from '../src/state.mjs';
import { createRuntimeApplication } from '../src/service/application.mjs';
import { createParticipationRuntime } from '../src/service/participation-runtime.mjs';

const P='a'.repeat(64), C='b'.repeat(64), site='http://127.0.0.1:8787';
async function fixture(t) {
  const home=mkdtempSync(join(tmpdir(),'k42-computer-hosting-')),folder=join(home,'selected game');mkdirSync(folder);
  writeFileSync(join(folder,'index.html'),'<h1>Verified static game</h1>');
  const artifact=(await inspectProjectOutput(home,folder)).artifact,requests=[];
  let pending,hook=()=>{},candidateDigest=artifact.digest,rateLimited=false,mode='approval';
  const fetchImpl=async(url,options)=>{
    const path=new URL(url).pathname;requests.push({path,...options});const override=await hook(path,options);if(override instanceof Response)return override;
    if(path==='/api/owner/connect'){pending=JSON.parse(options.body);return Response.json({requestId:pending.requestId,status:'pending',expiresAt:601000,verificationCode:'12345678'});}
    if(path.startsWith('/api/owner/connect/'))return Response.json({status:'approved',connectionExpiresAt:86401000,personName:'Owner',personId:'owner'});
    assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');assert.equal(options.headers['X-Mlswarm-Profile-Id'],'owner');assert.ok(options.headers.Authorization.startsWith('Bearer '));assert.equal('x-pilot-run' in options.headers,false);
    if(path.endsWith('/files/0')){
      if(rateLimited){rateLimited=false;return Response.json({message:'Retry the same file.'},{status:429,headers:{'Retry-After':'0.001'}});}
      assert.ok(Buffer.isBuffer(options.body));assert.equal(options.headers['content-type'],'application/octet-stream');return Response.json({ok:true});
    }
    if(path.endsWith('/status'))return Response.json({digest:artifact.digest,uploaded:[]});
    if(path.endsWith('/seal'))return Response.json({state:'ready'});
    if(path.endsWith('/candidates/'+C))return Response.json({candidateId:C,artifact:{...artifact,digest:candidateDigest}});
    if(path.endsWith('/candidates'))return Response.json({candidateId:C,state:'uploading'});
    if(path.endsWith('/publications'))return Response.json({id:'c'.repeat(64),state:'published',artifact:artifact.digest});
    if(path.endsWith('/policy'))return Response.json({policy:{revision:2}});
    return Response.json({configured:true,policy:{enabled:true,revision:1,mode},candidates:[]});
  };
  const client=createOwnerClient({home,site,fetchImpl,now:()=>1000});await client.connect();await client.finish();requests.length=0;
  t.after(()=>rmSync(home,{recursive:true,force:true}));
  return {home,folder,artifact,client,requests,set hook(fn){hook=fn;},set candidateDigest(v){candidateDigest=v;},rateLimit(){rateLimited=true;},set mode(v){mode=v;}};
}
const upload=f=>({project_id:P,directoryPath:f.folder,clientRequestId:'fixed-upload',expectedArtifact:f.artifact.digest,confirmPublic:true});

test('read-only MCP inspection returns the exact upload digest without provider POSTs',async t=>{
  const f=await fixture(t);
  const result=await f.client.operation('inspect_project_output',{project_id:P,directoryPath:f.folder});
  assert.deepEqual(result,{artifact:f.artifact.digest,manifest:f.artifact.manifest,bytes:f.artifact.bytes,fileCount:1});
  assert.deepEqual(f.requests.map(r=>[r.method,r.path]),[['GET',`/api/owner/project-hosting/${P}`]]);
  assert.equal('root' in result,false);assert.equal('directory' in result,false);
  assert.equal((await f.client.operation('upload_project_output',{...upload(f),expectedArtifact:result.artifact})).artifact,result.artifact);
});
test('inspection refuses root and linked folders and checks membership before file reads',async t=>{
  const f=await fixture(t),linked=join(f.home,'linked inspection');symlinkSync(f.folder,linked,'dir');
  for(const directoryPath of ['/',linked,'relative/output'])await assert.rejects(f.client.operation('inspect_project_output',{project_id:P,directoryPath}));
  assert.equal(f.requests.some(r=>r.method==='POST'),false);
  f.hook=()=>Response.json({error:'forbidden',message:'Current membership required.'},{status:403});
  await assert.rejects(f.client.operation('inspect_project_output',{project_id:P,directoryPath:join(f.home,'missing folder')}),/membership/);
});

test('approved computer uploads exact selected bytes without a run or execution control',async t=>{
  const f=await fixture(t), result=await f.client.operation('upload_project_output',upload(f),{expectedProfileId:'owner'});
  assert.equal(result.state,'awaiting_approval');assert.equal(result.artifact,f.artifact.digest);
  assert.deepEqual(f.requests.map(r=>r.path),[`/api/owner/project-hosting/${P}`,`/api/owner/project-hosting/${P}/candidates`,`/api/owner/project-hosting/${P}/candidates/${C}/status`,`/api/owner/project-hosting/${P}/candidates/${C}/files/0`,`/api/owner/project-hosting/${P}/candidates/${C}/seal`]);
  assert.ok(f.requests.every(r=>!r.path.includes('/control')&&!r.path.includes('/runs')));
  const intents=join(f.home,'owners',digest(site),'hosting');assert.ok(readFileSync(join(intents,digest('upload_project_output:fixed-upload')+'.json'),'utf8').includes('connectionId'));
});
test('wrong digest, missing explicit public consent and old participation input disclose no bytes',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.client.operation('upload_project_output',{...upload(f),expectedArtifact:'d'.repeat(64)}),/differs/);
  assert.equal(f.requests.filter(r=>r.method==='POST').length,0);
  for(const patch of [{confirmPublic:false},{participation_ref:randomUUID()},{directoryPath:'/'}])await assert.rejects(f.client.operation('upload_project_output',{...upload(f),clientRequestId:randomUUID(),...patch}));
  assert.equal(f.requests.filter(r=>r.method==='POST').length,0);
});
test('selected roots, symlink folders and oversized files are refused before file disclosure',async t=>{
  const f=await fixture(t),linked=join(f.home,'linked game');symlinkSync(f.folder,linked,'dir');
  await assert.rejects(f.client.operation('upload_project_output',{...upload(f),directoryPath:linked,clientRequestId:'linked'}),/symbolic|junction/);
  writeFileSync(join(f.folder,'index.html'),Buffer.alloc(8*1024*1024+1));
  await assert.rejects(f.client.operation('upload_project_output',{...upload(f),clientRequestId:'oversized'}),/unlinked|file|metadata/i);
  assert.equal(f.requests.filter(r=>r.method==='POST').length,0);
});

test('cancellation after an upload response prevents sealing or activation',async t=>{
  const f=await fixture(t),abort=new AbortController();
  f.hook=path=>{if(path.endsWith('/files/0'))abort.abort();};
  await assert.rejects(f.client.operation('upload_project_output',upload(f),{signal:abort.signal}),/abort/i);
  assert.equal(f.requests.some(r=>r.path.endsWith('/seal')||r.path.endsWith('/publications')),false);
});

test('lost replies retain decision identity; changed bytes or computer cannot replace it',async t=>{
  const f=await fixture(t);let lost=true;
  f.hook=path=>{if(lost&&path.endsWith('/candidates')){lost=false;throw Error('opaque transport secret');}};
  await assert.rejects(f.client.operation('upload_project_output',upload(f)),/same request/i);
  await f.client.operation('upload_project_output',upload(f));
  await assert.rejects(f.client.operation('upload_project_output',{...upload(f),expectedArtifact:'d'.repeat(64)}),/original/);
  const savedPath=join(f.home,'owners',digest(site),'owner.json'),saved=JSON.parse(readFileSync(savedPath));
  saved.requestId=randomUUID();writeFileSync(savedPath,JSON.stringify(saved),{mode:0o600});
  await assert.rejects(f.client.operation('upload_project_output',upload(f)),/original/);
});
test('account change during inspection/upload refuses before further bytes',async t=>{
  const f=await fixture(t);f.hook=path=>{if(path.endsWith('/status')){const path=join(f.home,'owners',digest(site),'owner.json'),saved=JSON.parse(readFileSync(path));saved.personId='another-owner';writeFileSync(path,JSON.stringify(saved),{mode:0o600});}};
  await assert.rejects(f.client.operation('upload_project_output',upload(f)),/account|connection/i);
  assert.equal(f.requests.some(r=>r.path.includes('/files/')),false);
});
test('hosting configuration and approval use exact schema and immutable digest',async t=>{
  const f=await fixture(t);
  await f.client.operation('configure_project_hosting',{project_id:P,client_request_id:'policy',expected_revision:1,confirm_public:true,mode:'approval',approvers:['owner'],submitters:['owner'],approved:true});
  assert.deepEqual(JSON.parse(f.requests.at(-1).body),{clientRequestId:'policy',expectedRevision:1,confirmPublic:true,mode:'approval',approvers:['owner'],submitters:['owner']});
  const input={project_id:P,candidate_id:C,policy_revision:1,expected_artifact:f.artifact.digest,client_request_id:'approve',approved:true};
  f.candidateDigest='d'.repeat(64);await assert.rejects(f.client.operation('approve_project_output',input),/differs/);
  assert.equal(f.requests.some(r=>r.path.endsWith('/publications')),false);
  f.candidateDigest=f.artifact.digest;assert.equal((await f.client.operation('approve_project_output',input)).state,'published');
  assert.deepEqual(JSON.parse(f.requests.at(-1).body),{clientRequestId:'approve',policyRevision:1,candidateId:C});
});
test('file throttling retries identical bytes and never starts a model',async t=>{
  const f=await fixture(t);f.rateLimit();await f.client.operation('upload_project_output',upload(f));
  const files=f.requests.filter(r=>r.path.endsWith('/files/0'));assert.equal(files.length,2);assert.deepEqual(files[0].body,files[1].body);
});
test('automatic owner policy requests publication only after a verified sealed upload',async t=>{
  const f=await fixture(t);f.mode='automatic';
  const result=await f.client.operation('upload_project_output',upload(f));
  assert.equal(result.state,'published');assert.equal(result.artifact,f.artifact.digest);
  const paths=f.requests.map(r=>r.path);assert.ok(paths.findIndex(p=>p.endsWith('/seal'))<paths.findIndex(p=>p.endsWith('/publications')));
  assert.deepEqual(JSON.parse(f.requests.at(-1).body),{clientRequestId:'fixed-upload-publish',candidateId:C,policyRevision:1});
});
test('remote computer revocation stops the upload and retires only that saved approval',async t=>{
  const f=await fixture(t);
  f.hook=path=>path.endsWith('/status')?Response.json({error:'unauthorized',message:'This computer approval expired or was ended.'},{status:401}):undefined;
  await assert.rejects(f.client.operation('upload_project_output',upload(f)),/not approved|approval has ended/i);
  assert.equal(f.requests.some(r=>r.path.includes('/files/')),false);
  const before=f.requests.length;await assert.rejects(f.client.operation('get_project_hosting',{project_id:P}),/not approved|approval has ended/i);assert.equal(f.requests.length,before);
});

test('root catalog has one canonical upload and rejects legacy participation shape; workers retain their run-scoped tool',async t=>{
  const f=await fixture(t),principal={site,ownerId:'owner'};
  const participation=createParticipationRuntime({store:{reserveOperation(){},expireParticipations:async()=>[]},principal,resolveBinding:async()=>null});t.after(()=>participation.close());
  const app=createRuntimeApplication({controllers:{},principal,ownerClient:f.client,participation,workerOperations:{listTools:()=>[PROJECT_OUTPUT_TOOL],callTool:()=>assert.fail('Not a worker request')}});
  const owner={kind:'owner',...principal};const tools=app.listTools(owner);
  assert.equal(new Set(tools.map(x=>x.name)).size,tools.length);assert.equal(tools.filter(t=>t.name==='upload_project_output').length,1);
  assert.equal(participation.listTools().some(t=>t.name==='upload_project_output'),false);
  assert.equal(tools.find(t=>t.name==='inspect_project_output').annotations.readOnlyHint,true);
  const rejected=await app.callTool(owner,'upload_project_output',{directoryPath:f.folder,clientRequestId:'old',participation_ref:randomUUID()});assert.equal(rejected.isError,true);assert.equal(f.requests.length,0);
  const worker={kind:'worker',target:{...principal,projectId:P,agentId:'agent'},missionId:randomUUID(),generation:1};
  assert.deepEqual(app.listTools(worker)[0].inputSchema.required,['directoryPath','clientRequestId']);
  assert.equal(app.listTools(worker).some(t=>t.name==='configure_project_hosting'),false);
  assert.equal(app.listTools(worker).some(t=>t.name==='inspect_project_output'),false);
});
