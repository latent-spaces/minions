import { beforeEach, test, expect } from 'vitest';
import { db, inProject, profiles } from '../src/firestore.js';
import { configureWorkspace, controlWorkspace, readWorkspace, editCard, CONTROL } from '../src/projects/store.js';
import { assertChatWrite, chatReadAccess } from '../src/projects/chat-records.js';
import { assertNewProgressAction } from '../src/projects/progress-authority.js';
import { saveProjectUpdateSettings } from '../src/projects/progress-settings.js';
import { sendMessageV2 } from '../src/v2/messages.js';
import { syncWorkerSession, listMyWorkers } from '../src/projects/worker-sessions.js';
import { reportPhase, startRun } from '../src/v2/runs.js';
import { agents, projectCollection, type Transaction } from '../src/firestore.js';
import { TransactionPrototype } from './store-prototypes.js';
import { randomUUID } from 'node:crypto';
import { seed, seedApprovedProject, resetEmulator, TEST_PROJECT, loadAgent } from './helpers.js';
const now=()=>10000;
beforeEach(resetEmulator);
async function fixture(agents=[{person:0,name:'reviewer'}]) {
 const result=await seed({profiles:[{name:'Owner',email:'owner@example.test'},{name:'Member',email:'member@example.test'}],agents});
 const people=await Promise.all(result.personIds.map(async id=>({id,...(await profiles.doc(id).get()).data()!})));
 await seedApprovedProject(TEST_PROJECT,{ownerProfileId:people[0].id,required:false,definition:{title:'Lifecycle',goal:'Test lifecycle',beneficiaries:'Team',output:'Tests',scope:'Local',acceptanceCriteria:'Verified',sources:null,resources:null,mergeApproval:'humans'}});
 await configureWorkspace(people[0],TEST_PROJECT,{client_request_id:'configure',expected_revision:0,repoUrl:'https://github.com/example/review'},now);
 return {people,agent:await loadAgent(result.agents[0].agentId),agentIds:result.agents.map(a=>a.agentId)};
}
test('start, pause, close, reopen and resume preserve history, discussion and authorization boundaries',async()=>{
 const {people,agent}=await fixture(),[owner,member]=people;
 await controlWorkspace(owner,TEST_PROJECT,{action:'start',client_request_id:'start',expected_revision:1},now);
 await expect(controlWorkspace(member,TEST_PROJECT,{action:'pause',client_request_id:'member',expected_revision:2},now)).rejects.toMatchObject({code:'forbidden'});
 const pause={action:'pause' as const,client_request_id:'pause',expected_revision:2};
 await controlWorkspace(owner,TEST_PROJECT,pause,now);
 expect((await readWorkspace(owner,TEST_PROJECT)).project).toMatchObject({pauseRequest:{revision:3,requestedAt:10000}});
 expect(await controlWorkspace(owner,TEST_PROJECT,pause,now)).toMatchObject({replayed:true,execution:'paused'});
 await expect(controlWorkspace(owner,TEST_PROJECT,{action:'resume',client_request_id:'stale',expected_revision:2},now)).rejects.toMatchObject({code:'proposal_conflict'});
 await inProject(TEST_PROJECT,async()=>{
  await db.runTransaction(tx=>assertChatWrite(tx,TEST_PROJECT,owner,now));
  expect(await sendMessageV2(agent,{to:['project'],body:'Discussion while paused',clientId:'paused-discussion'},now)).toMatchObject({duplicate:false});
  // Paused agents post their last update and its image, but start no other new work (owner, 10 November 2026).
  const paused={kind:'agent' as const,agent,runId:'run'};
  await db.runTransaction(tx=>assertNewProgressAction(tx,paused,{whilePaused:true}));
  await expect(db.runTransaction(tx=>assertNewProgressAction(tx,paused))).rejects.toMatchObject({code:'paused'});
 });
 await controlWorkspace(owner,TEST_PROJECT,{action:'close',client_request_id:'close',expected_revision:3},now);
 const closed=await readWorkspace(owner,TEST_PROJECT);
 expect(closed).toMatchObject({execution:'closed',revision:4,state:{label:'Closed',next:{action:'reopen_project'}}});
 await inProject(TEST_PROJECT,async()=>{
  expect(await db.runTransaction(tx=>chatReadAccess(tx,TEST_PROJECT,owner,now))).toMatchObject({canSend:false});
  await expect(db.runTransaction(tx=>assertChatWrite(tx,TEST_PROJECT,owner,now))).rejects.toMatchObject({code:'forbidden'});
  await expect(sendMessageV2(agent,{to:['project'],body:'Blocked',clientId:'closed-discussion'},now)).rejects.toMatchObject({code:'forbidden'});
  await expect(db.runTransaction(tx=>assertNewProgressAction(tx,{kind:'person',person:owner}))).rejects.toMatchObject({code:'forbidden'});
  await expect(saveProjectUpdateSettings(owner.id,{expectedRevision:0,clientRequestId:'closed-setting',writingStyle: 'brief'},now)).rejects.toMatchObject({code:'forbidden'});
  // Reading retained messages and recovering an accepted receipt do not create a new contribution.
  expect(await sendMessageV2(agent,{to:['project'],body:'Discussion while paused',clientId:'paused-discussion'},now)).toMatchObject({duplicate:true});
 });
 await expect(editCard(owner,TEST_PROJECT,{client_request_id:'closed-card',expected_version:closed.cardVersion,definition:closed.definition},now)).rejects.toMatchObject({code:'forbidden'});
 await expect(controlWorkspace(owner,TEST_PROJECT,{action:'resume',client_request_id:'closed-resume',expected_revision:4},now)).rejects.toThrow(/Reopen/);
 await controlWorkspace(owner,TEST_PROJECT,{action:'reopen',client_request_id:'reopen',expected_revision:4},now);
 expect(await readWorkspace(owner,TEST_PROJECT)).toMatchObject({execution:'paused',revision:5});
 await inProject(TEST_PROJECT,()=>db.runTransaction(tx=>assertChatWrite(tx,TEST_PROJECT,owner,now)));
 await controlWorkspace(owner,TEST_PROJECT,{action:'resume',client_request_id:'resume',expected_revision:5},now);
 expect(await readWorkspace(owner,TEST_PROJECT)).toMatchObject({execution:'active',revision:6});
 expect((await readWorkspace(owner,TEST_PROJECT)).project?.pauseRequest).toBeUndefined();
});
test('saving the same repository with `.git` is not a repository change',async()=>{
 const {people:[owner]}=await fixture();
 await expect(configureWorkspace(owner,TEST_PROJECT,{client_request_id:'other',expected_revision:1,repoUrl:'https://github.com/example/elsewhere'},now)).rejects.toMatchObject({code:'bad_input'});
 await expect(configureWorkspace(owner,TEST_PROJECT,{client_request_id:'same',expected_revision:1,repoUrl:'https://github.com/Example/review.git'},now)).resolves.toBeTruthy();
});
const MIN=60_000;
test('add_time sets and extends the one job end time, counts from now once it passed, and stays within 24 hours',async()=>{
 const {people:[owner,member]}=await fixture(),at=1_000_000;
 const add=(id:string,revision:number,minutes:number,when=at)=>controlWorkspace(owner,TEST_PROJECT,{action:'add_time',client_request_id:id,expected_revision:revision,minutes},()=>when);
 expect((await readWorkspace(owner,TEST_PROJECT)).endsAt).toBeNull();
 // Time can be given before the project starts.
 expect(await add('t1',1,30)).toEqual({revision:2,execution:'ready',endsAt:at+30*MIN,tokenLimit:null,replayed:false});
 expect(await add('t1',1,30,at+5000)).toEqual({revision:2,execution:'ready',endsAt:at+30*MIN,tokenLimit:null,replayed:true});
 await expect(add('t1',1,60)).rejects.toMatchObject({code:'bad_input'});
 await expect(add('stale',1,30)).rejects.toMatchObject({code:'proposal_conflict'});
 expect(await add('t2',2,60)).toMatchObject({revision:3,endsAt:at+90*MIN});
 const later=at+200*MIN;
 expect(await add('t3',3,30,later)).toMatchObject({endsAt:later+30*MIN});
 await expect(add('t4',4,24*60,later)).rejects.toThrow(/24 hours/);
 expect(await add('t5',4,24*60-30,later)).toMatchObject({revision:5,endsAt:later+24*60*MIN});
 await expect(controlWorkspace(owner,TEST_PROJECT,{action:'add_time',client_request_id:'none',expected_revision:5},()=>later)).rejects.toMatchObject({code:'bad_input'});
 await expect(controlWorkspace(owner,TEST_PROJECT,{action:'pause',client_request_id:'pause-minutes',expected_revision:5,minutes:30},()=>later)).rejects.toMatchObject({code:'bad_input'});
 await expect(controlWorkspace(member,TEST_PROJECT,{action:'add_time',client_request_id:'mod',expected_revision:5,minutes:30},()=>later)).rejects.toMatchObject({code:'forbidden'});
 const workspace=await readWorkspace(owner,TEST_PROJECT);
 expect(workspace).toMatchObject({revision:5,endsAt:later+24*60*MIN,project:{endsAt:later+24*60*MIN,started:false}});
 expect((await inProject(TEST_PROJECT,()=>projectCollection('projectHistory').doc('000000000005').get())).data()).toMatchObject({control:{action:'add_time',minutes:24*60-30}});
});
test('starting with a length sets the end time; pause and resume leave it; a closed project refuses more time',async()=>{
 const {people:[owner]}=await fixture(),at=1_000_000;
 expect(await controlWorkspace(owner,TEST_PROJECT,{action:'start',client_request_id:'start',expected_revision:1,minutes:60},()=>at)).toEqual({revision:2,execution:'active',endsAt:at+60*MIN,tokenLimit:null,replayed:false});
 await controlWorkspace(owner,TEST_PROJECT,{action:'pause',client_request_id:'pause',expected_revision:2},()=>at+MIN);
 // Time can be added while paused, and the Pause request stays as it was.
 expect(await controlWorkspace(owner,TEST_PROJECT,{action:'add_time',client_request_id:'more',expected_revision:3,minutes:30},()=>at+2*MIN)).toMatchObject({execution:'paused',endsAt:at+90*MIN});
 expect((await readWorkspace(owner,TEST_PROJECT)).project).toMatchObject({paused:true,pauseRequest:{revision:3},endsAt:at+90*MIN});
 expect(await controlWorkspace(owner,TEST_PROJECT,{action:'resume',client_request_id:'resume',expected_revision:4},()=>at+3*MIN)).toMatchObject({execution:'active',endsAt:at+90*MIN});
 await controlWorkspace(owner,TEST_PROJECT,{action:'close',client_request_id:'close',expected_revision:5},()=>at+4*MIN);
 await expect(controlWorkspace(owner,TEST_PROJECT,{action:'add_time',client_request_id:'closed',expected_revision:6,minutes:30},()=>at+5*MIN)).rejects.toThrow(/Reopen/);
});
test('a worker keeps contact after the end time and receives the later end once the owner adds time',async()=>{
 const {people:[owner],agent}=await fixture(),at=1_000_000,scope=<T>(f:()=>T)=>inProject(TEST_PROJECT,f);
 await controlWorkspace(owner,TEST_PROJECT,{action:'start',client_request_id:'start',expected_revision:1,minutes:10},()=>at);
 const run=await scope(()=>startRun(agent.id,{clientRunId:randomUUID(),runnerVersion:'fake',takeover:false},()=>at));
 const session={run_id:run.run_id,missionId:run.run_id,generation:1,startedAt:at,deadlineAt:at+10*MIN,remainingSlots:64,phase:'working' as const};
 const contact=(input:object,when:number)=>scope(()=>syncWorkerSession(agent.id,input,()=>when));
 expect(await contact(session,at+MIN)).toEqual({missionId:session.missionId,authorizedDeadlineAt:at+10*MIN,tokenLimit:null});
 // Past the end time the worker finishes its turn, then waits: both contacts are accepted and it is not ended.
 expect(await contact(session,at+11*MIN)).toMatchObject({authorizedDeadlineAt:at+10*MIN});
 expect(await contact({...session,phase:'waiting'},at+12*MIN)).toMatchObject({authorizedDeadlineAt:at+10*MIN});
 expect((await scope(()=>listMyWorkers(owner.id,()=>at+12*MIN))).agents[0].worker).toMatchObject({available:true,session:{phase:'waiting'}});
 const added=await controlWorkspace(owner,TEST_PROJECT,{action:'add_time',client_request_id:'more',expected_revision:2,minutes:30},()=>at+13*MIN);
 expect(added.endsAt).toBe(at+43*MIN);
 expect(await contact({...session,phase:'waiting'},at+13*MIN+1000)).toEqual({missionId:session.missionId,authorizedDeadlineAt:at+43*MIN,tokenLimit:null});
 // The worker applies the new end and reports it back as its deadline.
 expect(await contact({...session,deadlineAt:at+43*MIN},at+14*MIN)).toMatchObject({authorizedDeadlineAt:at+43*MIN});
 expect((await scope(()=>listMyWorkers(owner.id,()=>at+14*MIN))).agents[0].worker.session).toMatchObject({deadlineAt:at+43*MIN,phase:'working'});
 await expect(contact({...session,deadlineAt:at+50*MIN},at+15*MIN)).rejects.toMatchObject({code:'bad_input'});
});
test('set_tokens sets, changes and removes the optional token cap; it is refused on other actions and without an amount',async()=>{
 const {people:[owner,member]}=await fixture(),at=1_000_000;
 const set=(id:string,revision:number,tokens:number|null)=>controlWorkspace(owner,TEST_PROJECT,{action:'set_tokens',client_request_id:id,expected_revision:revision,tokens},()=>at);
 // No cap by default.
 expect((await readWorkspace(owner,TEST_PROJECT)).tokenLimit).toBeNull();
 expect(await set('c1',1,50_000)).toEqual({revision:2,execution:'ready',endsAt:null,tokenLimit:{tokens:50_000},replayed:false});
 expect(await set('c1',1,50_000)).toMatchObject({revision:2,replayed:true});
 expect(await set('c2',2,80_000)).toMatchObject({revision:3,tokenLimit:{tokens:80_000}});
 expect((await readWorkspace(owner,TEST_PROJECT))).toMatchObject({tokenLimit:{tokens:80_000},project:{tokenLimit:{tokens:80_000}}});
 expect((await inProject(TEST_PROJECT,()=>projectCollection('projectHistory').doc('000000000003').get())).data()).toMatchObject({control:{action:'set_tokens',tokens:80_000}});
 // There is one pool only: no per-agent switch.
 expect(CONTROL.safeParse({action:'set_tokens',client_request_id:'shared',expected_revision:3,tokens:10,shared:true}).success).toBe(false);
 await expect(controlWorkspace(owner,TEST_PROJECT,{action:'set_tokens',client_request_id:'none',expected_revision:3},()=>at)).rejects.toMatchObject({code:'bad_input'});
 expect(CONTROL.safeParse({action:'set_tokens',client_request_id:'zero',expected_revision:3,tokens:0}).success).toBe(false);
 await expect(controlWorkspace(owner,TEST_PROJECT,{action:'add_time',client_request_id:'mixed',expected_revision:3,minutes:30,tokens:10} as never,()=>at)).rejects.toMatchObject({code:'bad_input'});
 await expect(controlWorkspace(member,TEST_PROJECT,{action:'set_tokens',client_request_id:'mod',expected_revision:3,tokens:10},()=>at)).rejects.toMatchObject({code:'forbidden'});
 expect(await set('c3',3,null)).toMatchObject({revision:4,tokenLimit:null});
 expect((await readWorkspace(owner,TEST_PROJECT)).tokenLimit).toBeNull();
});
// Two agents of the owner, each with a started run and its first mission, in a started job with a 1000-token cap.
async function poolFixture(names=['fox','owl']) {
 const {people:[owner],agentIds}=await fixture(names.map(name=>({person:0,name}))),at=1_000_000,scope=<T>(f:()=>T)=>inProject(TEST_PROJECT,f);
 await controlWorkspace(owner,TEST_PROJECT,{action:'start',client_request_id:'start',expected_revision:1,minutes:60},()=>at);
 await controlWorkspace(owner,TEST_PROJECT,{action:'set_tokens',client_request_id:'cap',expected_revision:2,tokens:1000},()=>at);
 const begin=async(id:string,when:number)=>{const run=await scope(()=>startRun(id,{clientRunId:randomUUID(),runnerVersion:'fake',takeover:false},()=>when));
  return {run_id:run.run_id,missionId:run.run_id,generation:1,startedAt:when,deadlineAt:at+60*MIN,remainingSlots:64,phase:'waiting' as const};};
 const sessions=await Promise.all(agentIds.map(id=>begin(id,at)));
 const contact=(i:number,counted:number,when=at+MIN)=>scope(()=>syncWorkerSession(agentIds[i],{...sessions[i],tokens:{counted,unknownTurns:0}},()=>when));
 const kill=(i:number,when:number)=>scope(()=>reportPhase(agentIds[i],sessions[i].run_id,{phase:'stopping',reason:'operator',workerSession:{...sessions[i],phase:'stopped',remainingSlots:0}},()=>when));
 return {owner,agentIds,at,scope,begin,sessions,contact,kill};
}
test('each worker hears the token cap in its reply, one pool with what the owner\'s other agents counted',async()=>{
 const {owner,agentIds,at,scope,sessions,contact}=await poolFixture();
 await controlWorkspace(owner,TEST_PROJECT,{action:'set_tokens',client_request_id:'none',expected_revision:3,tokens:null},()=>at);
 expect(await contact(0,700,at+MIN)).toMatchObject({tokenLimit:null});
 await controlWorkspace(owner,TEST_PROJECT,{action:'set_tokens',client_request_id:'again',expected_revision:4,tokens:1000},()=>at+MIN);
 // Each worker hears what the other counted; its own current mission it counts itself.
 expect(await contact(1,400,at+2*MIN)).toMatchObject({tokenLimit:{tokens:1000,othersUsed:700}});
 expect(await contact(0,700,at+2*MIN)).toMatchObject({tokenLimit:{tokens:1000,othersUsed:400}});
 const view=await scope(()=>listMyWorkers(owner.id,()=>at+2*MIN));
 expect(view.agents.find(a=>a.agentId===agentIds[0])!.worker.session).toMatchObject({tokens:{counted:700,unknownTurns:0},tokenLimit:{tokens:1000,othersUsed:400}});
 await expect(scope(()=>syncWorkerSession(agentIds[0],{...sessions[0],tokens:{counted:-1,unknownTurns:0}},()=>at+3*MIN))).rejects.toMatchObject({code:'bad_input'});
});
test('a killed agent\'s tokens stay in the pool, also when its stop report carries no count',async()=>{
 const {at,contact,kill}=await poolFixture();
 await contact(0,700);
 expect(await contact(1,100)).toMatchObject({tokenLimit:{othersUsed:700}});
 // fox is killed: its final stop contact carries no count.
 await kill(0,at+2*MIN);
 expect(await contact(1,100,at+3*MIN)).toMatchObject({tokenLimit:{tokens:1000,othersUsed:700}});
});
test('an agent stopped and started again in a new mission keeps its old tokens in the pool, for itself and for the others',async()=>{
 const {agentIds,at,scope,begin,contact,kill}=await poolFixture();
 await contact(0,700); await contact(1,100);
 await kill(0,at+2*MIN);
 // fox starts again: a new run and mission that counts from zero.
 const next=await begin(agentIds[0],at+3*MIN);
 const fox=(counted:number)=>scope(()=>syncWorkerSession(agentIds[0],{...next,tokens:{counted,unknownTurns:0}},()=>at+4*MIN));
 expect(await fox(50)).toMatchObject({tokenLimit:{tokens:1000,othersUsed:700+100}});
 expect(await contact(1,100,at+4*MIN)).toMatchObject({tokenLimit:{othersUsed:700+50}});
});
test('the owner reads the whole pool with the project, ended and earlier missions included',async()=>{
 const {owner,agentIds,at,scope,begin,contact,kill}=await poolFixture();
 await contact(0,700); await contact(1,100);
 await kill(0,at+2*MIN);
 const next=await begin(agentIds[0],at+3*MIN);
 await scope(()=>syncWorkerSession(agentIds[0],{...next,tokens:{counted:50,unknownTurns:0}},()=>at+4*MIN));
 expect(await readWorkspace(owner,TEST_PROJECT)).toMatchObject({tokenLimit:{tokens:1000},tokensUsed:700+100+50});
 await controlWorkspace(owner,TEST_PROJECT,{action:'set_tokens',client_request_id:'none',expected_revision:3,tokens:null},()=>at+5*MIN);
 expect((await readWorkspace(owner,TEST_PROJECT)).tokensUsed).toBeUndefined();
});
test('a revoked agent\'s tokens stay in the pool',async()=>{
 const {agentIds,at,scope,contact,kill}=await poolFixture();
 await contact(0,700); await contact(1,100);
 await kill(0,at+2*MIN);
 await scope(()=>agents().doc(agentIds[0]).update({revokedAt:at+2*MIN}));
 expect(await contact(1,100,at+3*MIN)).toMatchObject({tokenLimit:{othersUsed:700}});
});
test('the pool sum stays a safe integer, so a worker can always read its reply',async()=>{
 const {contact}=await poolFixture(['fox','bat','owl']);
 await contact(0,Number.MAX_SAFE_INTEGER); await contact(1,Number.MAX_SAFE_INTEGER);
 expect(await contact(2,0)).toMatchObject({tokenLimit:{othersUsed:Number.MAX_SAFE_INTEGER}});
});
test('a session sync reads the pool outside its transaction, so it never locks the other workers\' sessions',async()=>{
 const {agentIds,contact}=await poolFixture();
 await contact(0,700);
 const read:string[]=[], original=TransactionPrototype.get;
 Object.defineProperty(TransactionPrototype,'get',{configurable:true,writable:true,value:function(this:Transaction,...args:unknown[]){read.push((args[0] as {path?:string}).path ?? 'query');return (original as (...a:unknown[])=>unknown).apply(this,args);}});
 try { expect(await contact(1,100)).toMatchObject({tokenLimit:{othersUsed:700}}); }
 finally { Object.defineProperty(TransactionPrototype,'get',{configurable:true,writable:true,value:original}); }
 expect(read.filter(path=>path.includes(`/workerSessions/${agentIds[0]}`))).toEqual([]);
});
