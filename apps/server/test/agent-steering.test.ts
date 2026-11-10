import { randomUUID } from 'node:crypto';
import { beforeEach, expect, test } from 'vitest';
import { inProject } from '../src/firestore.js';
import { syncWorkerSession, listMyWorkers } from '../src/projects/worker-sessions.js';
import { startRun } from '../src/v2/runs.js';
import { resetEmulator, seed, TEST_PROJECT } from './helpers.js';
beforeEach(resetEmulator);
const scope = <T>(f: () => T) => inProject(TEST_PROJECT, f);
async function fixture() {
  const f = await seed({ profiles: [{ name: 'Alice', email: 'alice@example.test' }, { name: 'Admin', email: 'admin@example.test' }], agents: [{ person: 0, name: 'Fox' }, { person: 1, name: 'Owl' }] });
  const agent = f.agents[0].agentId, profile = f.personIds[0];
  const r = await scope(() => startRun(agent, { clientRunId: randomUUID(), runnerVersion: 'fake', takeover: false }, () => 1000));
  const session = { run_id: r.run_id, missionId: r.run_id, startedAt: 1000, remainingSlots: 64, phase: 'waiting' as const, generation: 1 };
  return { f, agent, profile, session, sync: (input: Parameters<typeof syncWorkerSession>[1] = session, at = 1100) => scope(() => syncWorkerSession(agent, input, () => at)), request: { id: randomUUID(), missionId: session.missionId, body: 'Focus on tests.' } };
}
test('a waiting worker held by a provider limit is shown with its retry time; a working report clears it',async()=>{
 const x=await fixture();
 await x.sync({...x.session,providerLimit:{retryAt:5000}},1100);
 expect((await scope(()=>listMyWorkers(x.profile,()=>1200))).agents[0].worker.session).toMatchObject({phase:'waiting',providerLimit:{retryAt:5000}});
 await x.sync({...x.session,providerLimit:{retryAt:null}},1300);
 expect((await scope(()=>listMyWorkers(x.profile,()=>1400))).agents[0].worker.session).toMatchObject({providerLimit:{retryAt:null}});
 // Only a waiting worker is held; a working report never carries it.
 await x.sync({...x.session,phase:'working',providerLimit:{retryAt:5000}},1500);
 expect((await scope(()=>listMyWorkers(x.profile,()=>1600))).agents[0].worker.session).not.toHaveProperty('providerLimit');
 await expect(x.sync({...x.session,providerLimit:{retryAt:-1}},1700)).rejects.toMatchObject({code:'bad_input'});
 await expect(x.sync({...x.session,providerLimit:{retryAt:1,reason:'429'}} as never,1700)).rejects.toMatchObject({code:'bad_input'});
});
test('a worker in contact long after it started is listed as available and can be steered; an old end time is accepted and ignored',async()=>{
 const x=await fixture();await x.sync();
 const later=x.session.startedAt+48*60*60_000;
 expect(await x.sync({...x.session,phase:'working'} as never,later)).toEqual({missionId:x.session.missionId,tokenLimit:null});
 const view=await scope(()=>listMyWorkers(x.profile,()=>later+1000));
 expect(view.agents[0].worker).toMatchObject({available:true,session:{phase:'working'}});
 expect(view.agents[0].worker.session).not.toHaveProperty('deadlineAt');
 // A stop report queued before 10 November 2026 still carries an end time that has passed: it is accepted and ignored.
 expect(await x.sync({...x.session,phase:'working',deadlineAt:x.session.startedAt+60_000} as never,later+2000)).toEqual({missionId:x.session.missionId,tokenLimit:null});
 const after=await scope(()=>listMyWorkers(x.profile,()=>later+3000));
 expect(after.agents[0].worker).toMatchObject({available:true,session:{phase:'working'}});
 expect(after.agents[0].worker.session).not.toHaveProperty('deadlineAt');
 await expect(x.sync({...x.session,supportsDeadlineExtension:false} as never,later+2000)).rejects.toMatchObject({code:'bad_input'});
 await expect(x.sync({...x.session,untilProjectEnds:true} as never,later+2000)).rejects.toMatchObject({code:'bad_input'});
});

test('shared acceptance precedes delivery; exact retries, ownership, ordering and receipt evidence are fenced', async () => {
  const x=await fixture();await x.sync();
  const {submitSteering,pendingSteering,observeSteering,conversationEntries}=await import('../src/projects/steering.js');
  const {createHash}=await import('node:crypto');
  const first={operationId:'ffffffff-ffff-4fff-8fff-ffffffffffff',agentId:x.agent,missionId:x.session.missionId,generation:1,body:'First guidance',origin:'coding_chat' as const};
  const second={...first,operationId:'00000000-0000-4000-8000-000000000001',body:'Second guidance'};
  await expect(scope(()=>submitSteering(x.f.personIds[1],first,()=>1200))).rejects.toMatchObject({code:'forbidden'});
  const accepted=await scope(()=>submitSteering(x.profile,first,()=>1200));
  expect(await scope(()=>submitSteering(x.profile,first,()=>1300))).toMatchObject({created:false,message:accepted.message});
  await expect(scope(()=>submitSteering(x.profile,{...first,body:'Changed'},()=>1300))).rejects.toMatchObject({code:'duplicate'});
  await expect(scope(()=>submitSteering(x.profile,{...second,generation:2},()=>1300))).rejects.toMatchObject({code:'bad_input'});
  await scope(()=>submitSteering(x.profile,second,()=>1400));
  const {communicationTraffic}=await import('../src/view/communication.js');
  const graph=await scope(()=>communicationTraffic({},1500));
  expect(graph.traffic).toHaveLength(2);
  expect(graph.traffic.every(m=>m.agentId===`person:${x.profile}`&&m.to[0]===x.agent&&!('body' in m))).toBe(true);
  expect((await scope(()=>pendingSteering(x.agent,x.session.missionId,()=>1500))).map(m=>m.body)).toEqual(['First guidance','Second guidance']);
  const receipt=(state:'received'|'included'|'ended'|'uncertain',sequence:number)=>({receiptId:createHash('sha256').update(JSON.stringify(['steering',x.session.missionId,first.operationId,state])).digest('hex'),operationId:first.operationId,missionId:first.missionId,generation:1,state,sequence,observedAt:1500,turnId:state==='included'||state==='uncertain'?first.operationId:null});
  await scope(()=>observeSteering(x.agent,receipt('included',3),()=>1600));
  await scope(()=>observeSteering(x.agent,receipt('received',1),()=>1700));
  expect((await scope(()=>conversationEntries().doc(accepted.message.id).get())).data()).toMatchObject({state:'included',actorProfileId:x.profile,origin:'coding_chat'});
  await expect(scope(()=>observeSteering(x.agent,{...receipt('ended',4),sequence:1},()=>1700))).rejects.toMatchObject({code:'bad_input'});
});

test('stop before download settles queued history as unconfirmed; later native evidence remains authoritative', async()=>{
 const x=await fixture();await x.sync();
 const {submitSteering,conversationEntries}=await import('../src/projects/steering.js');
 const m=await scope(()=>submitSteering(x.profile,{operationId:randomUUID(),agentId:x.agent,missionId:x.session.missionId,generation:1,body:'Wait at the checkpoint',origin:'coding_chat'},()=>1200));
 await scope(()=>syncWorkerSession(x.agent,{...x.session,phase:'stopped'},()=>1300));
 expect((await scope(()=>conversationEntries().doc(m.message.id).get())).data()).toMatchObject({kind:'steering',state:'uncertain'});
 expect(await scope(()=>submitSteering(x.profile,{operationId:m.message.operationId,agentId:x.agent,missionId:x.session.missionId,generation:1,body:m.message.body,origin:'coding_chat'},()=>1400))).toMatchObject({message:{id:m.message.id}});
});
