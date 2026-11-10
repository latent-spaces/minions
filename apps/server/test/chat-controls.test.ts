import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { collection, inProject } from '../src/firestore.js';
import { assertCurrentRun, extendChatParticipation, reportPhase, startChatParticipation } from '../src/v2/runs.js';
import { presence, runs, runHistory } from '../src/v2/records.js';
import { runHistoryId } from '../src/v2/turn-reports.js';
import { syncParticipations, requestParticipationControl, readParticipationCommands } from '../src/projects/chat-controls.js';
import { listMyWorkers } from '../src/projects/worker-sessions.js';
import { resetEmulator, seed, TEST_PROJECT } from './helpers.js';

let at:number;
const scope=<T>(fn:()=>T)=>inProject(TEST_PROJECT,fn);
const computer=randomUUID(), otherComputer=randomUUID();
beforeEach(async()=>{await resetEmulator();at=2_000_000_000_000;vi.spyOn(Date,'now').mockImplementation(()=>at);});
afterEach(()=>vi.restoreAllMocks());
async function fixture() {
  const f=await seed({profiles:[{name:'Owner',email:'owner@example.test'},{name:'Admin',email:'admin@example.test' }],agents:[{person:0,name:'Chat'}]});
  const owner=f.personIds[0],agentId=f.agents[0].agentId,participationId=randomUUID();
  await collection('computerConnections').doc(computer).set({ profileId: owner, approvedAt: at, revokedAt: null, connectionExpiresAt: at + 86400_000 });
  const approvedAt=at,deadlineAt=at+600_000;
  const started=await scope(()=>startChatParticipation(agentId,{clientRunId:participationId,runnerVersion:'synthetic-chat',approvedAt,deadlineAt},()=>at));
  const snapshot={target:{site:'https://karma42.ai',ownerId:owner,projectId:TEST_PROJECT,agentId},participationId,generation:17,
    state:'active' as const,scope:'Review the test fixture.',approvedAt,deadlineAt,cloudRun:{runId:participationId,generation:started.generation,deadlineAt}};
  await syncParticipations(owner,computer,{participations:[snapshot]},()=>at);
  const request=(kind:'extend'|'release'|'wake',minutes?:number)=>({id:randomUUID(),kind,participationId,generation:17,expectedDeadlineAt:deadlineAt,...(minutes===undefined?{}:{minutes}),approved:true});
  return {...f,owner,agentId,snapshot,request};
}
test('website extension saves the exact cloud receipt retried by the device without adding time twice',async()=>{
  const f=await fixture(),input=f.request('extend',5);
  at+=1000;
  const first=await scope(()=>requestParticipationControl(f.owner,f.agentId,input,()=>at));
  expect(first).toMatchObject({replayed:false,participation:{pending:{kind:'extend',state:'queued',approvedAt:at,deadlineAt:f.snapshot.deadlineAt+300_000}}});
  at+=1000;
  expect(await scope(()=>requestParticipationControl(f.owner,f.agentId,{...input},()=>at))).toMatchObject({replayed:true,participation:{pending:first.participation.pending}});
  const mail=await readParticipationCommands(f.owner,computer,{},()=>at);
  const command=mail.commands[0].command;
  expect(command).toMatchObject({version:1,operationId:input.id,kind:'extend',target:f.snapshot.target,participationId:f.snapshot.participationId,generation:17});
  const p=command.payload as {approvedAt:number;deadlineAt:number;expectedDeadlineAt:number};
  expect(await scope(()=>extendChatParticipation(f.agentId,f.snapshot.participationId,{clientRequestId:input.id,approvedAt:p.approvedAt,deadlineAt:p.deadlineAt,expectedDeadlineAt:p.expectedDeadlineAt},()=>at)))
    .toEqual({run_id:f.snapshot.participationId,deadline_at:p.deadlineAt});
  expect((await scope(()=>runs().doc(f.agentId).get())).data()?.deadlineAt).toBe(p.deadlineAt);
  const updated={...f.snapshot,deadlineAt:p.deadlineAt,cloudRun:{...f.snapshot.cloudRun,deadlineAt:p.deadlineAt}};
  await syncParticipations(f.owner,computer,{participations:[updated]},()=>at);
  await expect(syncParticipations(f.owner,computer,{participations:[f.snapshot]},()=>at)).rejects.toMatchObject({code:'runtime_conflict'});
});
test('offline End fences project tools immediately and exact later terminal evidence remains idempotent',async()=>{
  const f=await fixture(),input=f.request('release');
  await scope(()=>requestParticipationControl(f.owner,f.agentId,input,()=>at));
  await expect(scope(()=>assertCurrentRun(f.agentId,f.snapshot.participationId))).rejects.toMatchObject({code:'run_superseded'});
  // The status document records the end with the run (stage E1).
  expect((await scope(()=>presence().doc(f.agentId).get())).data()).toMatchObject({runId:f.snapshot.participationId,runEndedAt:at,runMode:'current_chat'});
  const history=(await scope(()=>runHistory().doc(runHistoryId(f.agentId,f.snapshot.participationId)).get())).data();
  at+=1000;
  await scope(()=>reportPhase(f.agentId,f.snapshot.participationId,{phase:'stopping',reason:'operator'},()=>at));
  expect((await scope(()=>runHistory().doc(runHistoryId(f.agentId,f.snapshot.participationId)).get())).data()).toEqual(history);
  expect((await scope(()=>requestParticipationControl(f.owner,f.agentId,input,()=>at))).replayed).toBe(true);
  // A delayed active snapshot cannot reopen the cloud's ended generation.
  await syncParticipations(f.owner,computer,{participations:[f.snapshot]},()=>at);
  expect((await scope(()=>listMyWorkers(f.owner,()=>at))).agents[0].participation?.state).toBe('released');
});
test('Wake uses approval-time absolute deadline and fresh immutable identity without registering a run',async()=>{
  const f=await fixture();at=f.snapshot.deadlineAt;
  const input=f.request('wake',5),first=await scope(()=>requestParticipationControl(f.owner,f.agentId,input,()=>at));
  const initial=await readParticipationCommands(f.owner,computer,{},()=>at),command=initial.commands[0].command;
  expect(command.payload).toMatchObject({approved:true,approvedAt:at,deadlineAt:at+300_000});
  expect(command.payload.nextParticipationId).not.toBe(f.snapshot.participationId);
  expect((await scope(()=>runs().doc(f.agentId).get())).data()?.runId).toBe(f.snapshot.participationId);
  at+=400_000;
  const replay=await scope(()=>requestParticipationControl(f.owner,f.agentId,input,()=>at));
  expect(replay).toMatchObject({replayed:true,participation:{pending:{...first.participation.pending,state:'expired'}}});
  expect((await readParticipationCommands(f.owner,computer,{},()=>at)).commands[0].command).toEqual(command);
});
test('new grants do not replace pending Wake and admin role cannot control another human agent',async()=>{
  const f=await fixture();
  await expect(scope(()=>requestParticipationControl(f.personIds[1],f.agentId,f.request('release'),()=>at))).rejects.toMatchObject({code:'forbidden'});
  at=f.snapshot.deadlineAt;
  await scope(()=>requestParticipationControl(f.owner,f.agentId,f.request('wake',10),()=>at));
  await expect(scope(()=>requestParticipationControl(f.owner,f.agentId,f.request('wake',5),()=>at))).rejects.toMatchObject({code:'runtime_conflict'});
  await expect(scope(()=>requestParticipationControl(f.owner,f.agentId,f.request('release'),()=>at))).rejects.toMatchObject({code:'runtime_conflict'});
  await expect(syncParticipations(f.owner,otherComputer,{participations:[{...f.snapshot,state:'expired'}]},()=>at)).rejects.toMatchObject({code:'runtime_conflict'});
});
test('snapshot ownership and generations cannot override another current window or broaden scope',async()=>{
  const f=await fixture();
  await expect(syncParticipations(f.personIds[1],computer,{participations:[f.snapshot]},()=>at)).rejects.toMatchObject({code:'forbidden'});
  await expect(syncParticipations(f.owner,otherComputer,{participations:[f.snapshot]},()=>at)).rejects.toMatchObject({code:'runtime_conflict'});
  await expect(syncParticipations(f.owner,computer,{participations:[{...f.snapshot,generation:16}]},()=>at)).rejects.toMatchObject({code:'runtime_conflict'});
  await expect(syncParticipations(f.owner,computer,{participations:[{...f.snapshot,scope:'Broader authority'}]},()=>at)).rejects.toMatchObject({code:'runtime_conflict'});
  await expect(syncParticipations(f.owner,computer,{participations:[{...f.snapshot,target:{...f.snapshot.target,site:'https://attacker.test'}}]},()=>at)).rejects.toMatchObject({code:'bad_input'});
  at=f.snapshot.deadlineAt;
  await expect(syncParticipations(f.owner,otherComputer,{participations:[{...f.snapshot,state:'expired'}]},()=>at)).rejects.toMatchObject({code:'runtime_conflict'});
});

