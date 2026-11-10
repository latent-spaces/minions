import { createHash, randomUUID } from 'node:crypto';
import { beforeEach, expect, test } from 'vitest';
import { agents, inProject } from '../src/firestore.js';
import { submitSteering, pendingSteering, observeSteering, conversationEntries } from '../src/projects/steering.js';
import { syncWorkerSession } from '../src/projects/worker-sessions.js';
import { startRun } from '../src/v2/runs.js';
import { sendMessageV2, readThreadPage } from '../src/v2/messages.js';
import { readConversations, readThread } from '../src/view/conversations.js';
import { resetEmulator, seed, TEST_PROJECT } from './helpers.js';
beforeEach(resetEmulator);
const scope = <T>(f:()=>T)=>inProject(TEST_PROJECT,f);
async function fixture(){
  const f=await seed({profiles:[{name:'Alice',email:'alice@example.test'},{name:'Bob',email:'bob@example.test'}],agents:[{person:0,name:'Fox'},{person:0,name:'Owl'},{person:1,name:'Bear'}]});
  const recipients=[];
  for(const a of f.agents){
    const run=await scope(()=>startRun(a.agentId,{clientRunId:randomUUID(),runnerVersion:'fake',takeover:false},()=>1000));
    const session={run_id:run.run_id,missionId:run.run_id,startedAt:1000,remainingSlots:64,phase:'waiting' as const,generation:1};
    await scope(()=>syncWorkerSession(a.agentId,session,()=>1100));
    recipients.push({agentId:a.agentId,missionId:session.missionId,generation:1,operationId:randomUUID()});
  }
  const input={operationId:recipients[0].operationId,recipients:recipients.slice(0,2),body:'Focus on onboarding.',origin:'coding_chat' as const};
  return {f,input,recipients,owner:f.personIds[0]};
}
const receipt=(d:{operationId:string;missionId:string;generation:number},state:'received'|'included'|'ended'|'uncertain',sequence:number)=>({receiptId:createHash('sha256').update(JSON.stringify(['steering',d.missionId,d.operationId,state])).digest('hex'),operationId:d.operationId,missionId:d.missionId,generation:d.generation,state,sequence,observedAt:1400,turnId:['included','uncertain'].includes(state)?randomUUID():null});
test('one immutable send produces one conversation with independent per-agent delivery and exact retries',async()=>{
  const x=await fixture();
  const first=await scope(()=>submitSteering(x.owner,x.input,()=>1200));
  expect((await scope(()=>readConversations(undefined,()=>1300))).conversations).toHaveLength(1);
  expect((await scope(()=>readThread(first.message.id,{},()=>1300))).messages).toMatchObject([{body:x.input.body,audience:{to:x.input.recipients.map(d=>({id:d.agentId}))},steering:{deliveries:[{state:'queued'},{state:'queued'}]}}]);
  for(const d of x.input.recipients)expect(await scope(()=>pendingSteering(d.agentId,d.missionId,()=>1300))).toEqual([{id:d.operationId,body:x.input.body,missionId:d.missionId,generation:1,threadId:first.message.id}]);
  await Promise.all(x.input.recipients.map((d,i)=>scope(()=>observeSteering(d.agentId,receipt(d,i?'received':'included',i?1:3),()=>1400))));
  await scope(()=>observeSteering(x.recipients[0].agentId,receipt(x.recipients[0],'received',1),()=>1500));
  const retry=await scope(()=>submitSteering(x.owner,x.input,()=>1600));
  expect(retry).toMatchObject({created:false,message:{id:first.message.id,deliveries:[{state:'included'},{state:'received'}]}});
  await expect(scope(()=>submitSteering(x.owner,{...x.input,body:'Changed'},()=>1600))).rejects.toMatchObject({code:'duplicate'});
  await expect(scope(()=>submitSteering(x.owner,{...x.input,recipients:[x.recipients[0]]},()=>1600))).rejects.toMatchObject({code:'duplicate'});
  const later=x.input.recipients.map(d=>({...d,operationId:randomUUID()}));
  await scope(()=>submitSteering(x.owner,{...x.input,operationId:later[0].operationId,recipients:later},()=>1700));
  expect((await scope(()=>readConversations(undefined,()=>1800))).conversations).toHaveLength(2);
});
test('foreign, stale, duplicate or full recipients reject the entire send without records or deliveries',async()=>{
  const x=await fixture();
  for(const recipients of [[x.recipients[0],x.recipients[2]],[x.recipients[0],{...x.recipients[1],generation:2}],[x.recipients[0],x.recipients[0]]]){
    await expect(scope(()=>submitSteering(x.owner,{...x.input,recipients},()=>1200))).rejects.toBeDefined();
    expect((await scope(()=>conversationEntries().get())).size).toBe(0);
    expect(await scope(()=>pendingSteering(x.recipients[0].agentId,x.recipients[0].missionId,()=>1300))).toEqual([]);
  }
  const d=x.recipients[1];
  await scope(()=>syncWorkerSession(d.agentId,{run_id:d.missionId,missionId:d.missionId,startedAt:1000,remainingSlots:0,phase:'waiting',generation:1},()=>1150));
  await expect(scope(()=>submitSteering(x.owner,x.input,()=>1200))).rejects.toMatchObject({code:'limit_reached'});
  expect((await scope(()=>conversationEntries().get())).size).toBe(0);
});
test('ending one run does not overwrite other recipients and late inclusion remains authoritative',async()=>{
  const x=await fixture();const sent=await scope(()=>submitSteering(x.owner,x.input,()=>1200));const d=x.recipients[0];
  await scope(()=>syncWorkerSession(d.agentId,{run_id:d.missionId,missionId:d.missionId,startedAt:1000,remainingSlots:64,phase:'stopped',generation:1},()=>1300));
  expect((await scope(()=>conversationEntries().doc(sent.message.id).get())).data()).toMatchObject({deliveries:[{state:'uncertain'},{state:'queued'}]});
  await scope(()=>observeSteering(d.agentId,receipt(d,'included',3),()=>1400));
  expect((await scope(()=>conversationEntries().doc(sent.message.id).get())).data()).toMatchObject({deliveries:[{state:'included'},{state:'queued'}]});
});
test('explicit replies join the human conversation; unrelated messages stay separate; read_thread labels the person',async()=>{
  const x=await fixture();const sent=await scope(()=>submitSteering(x.owner,x.input,()=>1200));
  const agentDoc=await scope(()=>agents().doc(x.recipients[0].agentId).get());const agent={...agentDoc.data()!,id:agentDoc.id};
  const input={clientId:'reply',to:[],threadId:sent.message.id,body:'I will check the first step.'};
  const reply=await scope(()=>sendMessageV2(agent,input,()=>1400));
  expect(reply.message.threadId).toBe(sent.message.id);
  expect(await scope(()=>sendMessageV2(agent,input,()=>1500))).toMatchObject({duplicate:true});
  const next=await scope(()=>sendMessageV2(agent,{...input,clientId:'reply-again',threadId:reply.message.id},()=>10000));
  expect(next.message.threadId).toBe(sent.message.id);
  const history=await scope(()=>readThreadPage(sent.message.id));
  expect(history.messages.map(m=>m.id)).toEqual([sent.message.id,reply.message.id,next.message.id]);
  expect(history.messages[0].body.source).toEqual({type:'person',personId:x.owner});
  expect((await scope(()=>readThreadPage(reply.message.id,undefined,sent.message.id))).messages).toHaveLength(2);
  const unrelated=await scope(()=>sendMessageV2(agent,{clientId:'other',to:[x.recipients[1].agentId],body:'Separate work'},()=>20000));
  expect(unrelated.message.threadId).toBe(unrelated.message.id);
  await expect(scope(()=>sendMessageV2(agent,{clientId:'empty',to:[],body:'No thread'},()=>30000))).rejects.toMatchObject({code:'bad_input'});
  await expect(scope(()=>sendMessageV2(agent,{clientId:'wrong-thread',to:[],body:'Wrong thread',threadId:unrelated.message.id},()=>30000))).rejects.toMatchObject({code:'bad_input'});
});
