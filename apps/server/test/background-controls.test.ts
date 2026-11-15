import {notifications} from '../src/projects/moderation-notifications.js';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import express from 'express';
import { identity } from '../src/identity/index.js';
import { ownerRoutes } from '../src/owner/routes.js';
import { hashToken, newToken } from '../src/auth.js';
import { collection, inProject } from '../src/firestore.js';
import { syncBackgrounds, requestBackgroundControl, readBackgroundCommands, acknowledgeBackgroundCommand } from '../src/projects/background-controls.js';
import { startRun } from '../src/v2/runs.js';
import { projectManagementRoutes } from '../src/projects/routes.js';
import { idTokenFor, resetEmulator, seed, TEST_PROJECT } from './helpers.js';

let at:number;
const computer=randomUUID(),otherComputer=randomUUID();
const scope=<T>(fn:()=>T)=>inProject(TEST_PROJECT,fn);
beforeEach(async()=>{await resetEmulator();at=2_000_000_000_000;vi.spyOn(Date,'now').mockImplementation(()=>at);});
afterEach(()=>vi.restoreAllMocks());
async function fixture(){
  const f=await seed({profiles:[{name:'Owner',email:'owner@example.test'},{name:'Admin',email:'admin@example.test' }],agents:[{person:0,name:'Fox'}]});
  const owner=f.personIds[0];await collection('computerConnections').doc(computer).set({profileId:owner,revokedAt:null,approvedAt:at,connectionExpiresAt:at+86400_000});
  const agentId=f.agents[0].agentId,missionId=randomUUID();
  const run=await scope(()=>startRun(agentId,{clientRunId:missionId,runnerVersion:'synthetic-background',takeover:false},()=>at));
  const snapshot={target:{site:'https://karma42.ai',ownerId:owner,projectId:TEST_PROJECT,agentId},missionId,generation:17,deadlineAt:at+900_000,
    state:'running' as const,pauseOperationId:null as string|null,updatedAt:at,cloudRun:{runId:run.run_id,generation:run.generation}};
  const sync=(value:object=snapshot,device=computer)=>syncBackgrounds(owner,device,{backgrounds:[value]},()=>at);
  await sync();
  const request=(kind:'pause'|'resume',pauseOperationId?:string)=>({id:randomUUID(),kind,missionId,generation:17,approved:true,...(pauseOperationId ? {pauseOperationId}:{})});
  return {...f,owner,agentId,snapshot,sync,request};
}
test('foreign admin, wrong computer, invalid approval/generation and stale exact Pause are refused',async()=>{
  const f=await fixture(),pause=f.request('pause');
  await expect(scope(()=>requestBackgroundControl(f.personIds[1],f.agentId,pause,()=>at))).rejects.toMatchObject({code:'forbidden'});
  await expect(scope(()=>requestBackgroundControl(f.owner,f.agentId,{...pause,approved:false},()=>at))).rejects.toMatchObject({code:'bad_input'});
  await expect(scope(()=>requestBackgroundControl(f.owner,f.agentId,{...pause,generation:18},()=>at))).rejects.toMatchObject({code:'runtime_conflict'});
  await expect(scope(()=>requestBackgroundControl(f.owner,f.agentId,{...pause,minutes:30},()=>at))).rejects.toMatchObject({code:'bad_input'});
  await expect(f.sync(f.snapshot,otherComputer)).rejects.toMatchObject({code:'runtime_conflict'});
  await expect(f.sync({...f.snapshot,cloudRun:null})).rejects.toMatchObject({code:'runtime_conflict'});
  await expect(f.sync({...f.snapshot,cloudRun:{...f.snapshot.cloudRun,generation:999}})).rejects.toMatchObject({code:'runtime_conflict'});
  await scope(()=>requestBackgroundControl(f.owner,f.agentId,pause,()=>at));
  await expect(acknowledgeBackgroundCommand(f.owner,otherComputer,pause.id,{state:'accepted'},()=>at)).rejects.toMatchObject({code:'not_found'});
  await acknowledgeBackgroundCommand(f.owner,computer,pause.id,{state:'failed',message:'Refused.'},()=>at);
  at+=10;await f.sync({...f.snapshot,state:'paused',pauseOperationId:randomUUID(),updatedAt:at});
  await expect(scope(()=>requestBackgroundControl(f.owner,f.agentId,f.request('resume',pause.id),()=>at))).rejects.toMatchObject({code:'runtime_conflict'});
});
test('pause and stop are accepted and delivered after the job end time; a command carries its own expiry',async()=>{
  const f=await fixture();at=f.snapshot.deadlineAt+60_000;
  await f.sync({...f.snapshot,state:'waiting',updatedAt:at});
  const pause=f.request('pause');
  expect(await scope(()=>requestBackgroundControl(f.owner,f.agentId,pause,()=>at))).toMatchObject({background:{available:true,pending:{id:pause.id,state:'queued'}}});
  expect((await readBackgroundCommands(f.owner,computer,{},()=>at)).commands).toEqual([expect.objectContaining({id:pause.id,deadlineAt:at+24*60*60_000})]);
  await acknowledgeBackgroundCommand(f.owner,computer,pause.id,{state:'accepted'},()=>at);
  at+=10;await f.sync({...f.snapshot,state:'paused',pauseOperationId:pause.id,updatedAt:at});
  await acknowledgeBackgroundCommand(f.owner,computer,pause.id,{state:'applied'},()=>at);
  const stop={id:randomUUID(),kind:'stop' as const,missionId:f.snapshot.missionId,generation:17,approved:true};
  expect(await scope(()=>requestBackgroundControl(f.owner,f.agentId,stop,()=>at))).toMatchObject({background:{pending:{id:stop.id,kind:'stop',state:'queued'}}});
  at+=10;await f.sync({...f.snapshot,state:'stopped',updatedAt:at});
  await acknowledgeBackgroundCommand(f.owner,computer,stop.id,{state:'applied'},()=>at);
  expect((await readBackgroundCommands(f.owner,computer,{},()=>at)).commands).toEqual([]);
});
test('browser endpoint uses real human auth and never accepts agent tokens or peers',async()=>{
  vi.restoreAllMocks();at=Date.now();
  const f=await fixture(),app=express();app.use('/api/projects',projectManagementRoutes(()=>at));
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const call=(token?:string)=>fetch(`${base}/api/projects/${TEST_PROJECT}/agents/${f.agentId}/background-control`,{method:'POST',headers:{'content-type':'application/json',...(token ? {authorization:`Bearer ${token}`}:{})},body:JSON.stringify(f.request('pause'))});
  try {
    expect((await call()).status).toBe(401);
    expect((await call(f.agents[0].token)).status).toBe(401);
    expect((await call(await idTokenFor('admin@example.test'))).status).toBe(403);
    const result=await call(await idTokenFor('owner@example.test'));expect(result.status).toBe(200);
    expect(result.headers.get('cache-control')).toContain('no-store');expect(await result.json()).toMatchObject({background:{pending:{state:'queued'}}});
  }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error ? reject(error):resolve()));}
});

test('approved computer HTTP delivery publishes exact state and preserves queued/accepted/applied distinctions',async()=>{
  vi.restoreAllMocks();at=Date.now();
  const f=await fixture(),firebase=await idTokenFor('owner@example.test'),decoded=(await identity().verifySession(firebase))!,token=newToken();
  await collection('computerConnections').doc(computer).set({requestId:computer,profileId:f.owner,firebaseUid:decoded.subject,authenticatedAt:decoded.authTime*1000,
    candidateTokenHash:hashToken(token),pollingSecretHash:hashToken(newToken()),clientName:'Synthetic transport',createdAt:at,expiresAt:at+600_000,
    approvedAt:at,revokedAt:null,connectionExpiresAt:at+86400_000});
  const app=express();app.use('/api/owner',ownerRoutes(()=>at));const server=app.listen(0,'127.0.0.1');
  await new Promise<void>(resolve=>server.once('listening',resolve));const base=`http://127.0.0.1:${(server.address() as {port:number}).port}/api/owner`;
  const call=(path:string,body?:object,auth=token)=>fetch(base+path,{method:body?'POST':'GET',headers:{authorization:`Bearer ${auth}`,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});
  try{
    expect((await call('/background-controls',undefined,f.agents[0].token)).status).toBe(401);
    expect((await call('/backgrounds/sync',{backgrounds:[f.snapshot]})).status).toBe(200);
    const pause=f.request('pause');await scope(()=>requestBackgroundControl(f.owner,f.agentId,pause,()=>at));
    const queued=await (await call('/background-controls')).json();expect(queued.commands[0]).toMatchObject({id:pause.id,command:{version:2,payload:{}}});
    expect((await call(`/background-controls/${pause.id}/receipt`,{state:'accepted'})).status).toBe(200);
    expect((await call(`/background-controls/${pause.id}/receipt`,{state:'applied'})).status).toBe(409);
    at+=10;expect((await call('/backgrounds/sync',{backgrounds:[{...f.snapshot,state:'paused',pauseOperationId:pause.id,updatedAt:at}]})).status).toBe(200);
    expect((await call(`/background-controls/${pause.id}/receipt`,{state:'applied'})).status).toBe(200);
    expect((await (await call('/background-controls')).json()).commands).toEqual([]);
    await collection('computerConnections').doc(computer).update({revokedAt:at});
    expect((await call('/background-controls')).status).toBe(401);
  }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});

test('notifications HTTP is recipient-only, profile-fenced, paged and read-idempotent',async()=>{
  vi.restoreAllMocks();at=Date.now();const f=await fixture();
  for(let i=0;i<22;i++)await notifications(f.owner).doc(i.toString(16).padStart(64,'0')).set({id:i.toString(16).padStart(64,'0'),kind:'agent_moderation',projectId:TEST_PROJECT,projectTitle:'Synthetic',agentId:f.agentId,agentName:'Fox',actorProfileId:f.personIds[1],actorName:'Admin',action:'pause',reason:'Synthetic reason',createdAt:at+i,readAt:null});
  const app=express();app.use('/api/owner',ownerRoutes(()=>at));const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}/api/owner/notifications`,token=await idTokenFor('owner@example.test');
  const headers={authorization:`Bearer ${token}`,'X-Minions-Profile-Id':f.owner,'content-type':'application/json'};
  try{
    expect((await fetch(base)).status).toBe(401);
    expect((await fetch(base,{headers:{...headers,'X-Minions-Profile-Id':f.personIds[1]}})).status).toBe(401);
    const response=await fetch(base,{headers});expect(response.status).toBe(200);const first=await response.json();expect(first.items).toHaveLength(20);expect(first.next).toBeTruthy();
    const second=await (await fetch(base+'?cursor='+encodeURIComponent(first.next),{headers})).json();expect(second.items).toHaveLength(2);
    const id=first.items[0].id;expect((await fetch(base+'/'+id+'/read',{method:'POST',headers,body:'{}'})).status).toBe(200);
    expect((await fetch(base+'/'+id+'/read',{method:'POST',headers,body:'{}'})).status).toBe(200);
    const foreign={...headers,authorization:`Bearer ${await idTokenFor('admin@example.test')}`,'X-Minions-Profile-Id':f.personIds[1]};
    expect((await (await fetch(base,{headers:foreign})).json()).items).toEqual([]);
    expect((await fetch(base+'/'+id+'/read',{method:'POST',headers:foreign,body:'{}'})).status).toBe(404);
  }finally{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
});

test('notifications read-all clears every unread notice for the recipient only, idempotently',async()=>{
  vi.restoreAllMocks();at=Date.now();const f=await fixture();
  const notice=(i:number)=>({id:i.toString(16).padStart(64,'0'),kind:'agent_moderation' as const,projectId:TEST_PROJECT,projectTitle:'Synthetic',agentId:f.agentId,agentName:'Fox',actorProfileId:f.personIds[1],actorName:'Admin',action:'pause' as const,reason:'Synthetic reason',createdAt:at+i,readAt:null});
  for(let i=0;i<25;i++)await notifications(f.owner).doc(notice(i).id).set(notice(i));
  await notifications(f.personIds[1]).doc(notice(255).id).set(notice(255));
  const app=express();app.use('/api/owner',ownerRoutes(()=>at));const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}/api/owner/notifications`,token=await idTokenFor('owner@example.test');
  const headers={authorization:`Bearer ${token}`,'X-Minions-Profile-Id':f.owner,'content-type':'application/json'};
  try{
    expect((await fetch(base+'/read-all',{method:'POST',body:'{}',headers:{'content-type':'application/json'}})).status).toBe(401);
    expect((await fetch(base+'/read-all',{method:'POST',body:'{}',headers:{...headers,'X-Minions-Profile-Id':f.personIds[1]}})).status).toBe(401);
    expect((await fetch(base+'/read-all',{method:'POST',body:'{"x":1}',headers})).status).toBe(400);
    const first=await fetch(base+'/read-all',{method:'POST',body:'{}',headers});expect(first.status).toBe(200);expect(await first.json()).toEqual({ok:true,marked:25});
    expect(await (await fetch(base+'/read-all',{method:'POST',body:'{}',headers})).json()).toEqual({ok:true,marked:0});
    expect((await (await fetch(base,{headers})).json()).items).toEqual([]);
    expect((await notifications(f.personIds[1]).doc(notice(255).id).get()).data()?.readAt).toBeNull();
  }finally{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
});

test('read-all crosses the 400-notice batch boundary without changing another recipient',async()=>{
  const {markAllNotificationsRead}=await import('../src/projects/moderation-notifications.js');
  const {db}=await import('../src/firestore.js');
  const f=await fixture();
  const make=(i:number)=>({id:i.toString(16).padStart(64,'0'),kind:'agent_moderation' as const,projectId:TEST_PROJECT,projectTitle:'Synthetic',agentId:f.agents[0].agentId,agentName:'Fox',actorProfileId:f.personIds[1],actorName:'Admin',action:'pause' as const,reason:'Synthetic',createdAt:at+i,readAt:null});
  const batch=db.batch();for(let i=0;i<405;i++){const notice=make(i);batch.set(notifications(f.owner).doc(notice.id),notice);}
  const foreign=make(999);batch.set(notifications(f.personIds[1]).doc(foreign.id),foreign);await batch.commit();
  expect(await markAllNotificationsRead(f.owner,()=>at)).toEqual({ok:true,marked:405});
  expect((await notifications(f.owner).where('readAt','==',null).get()).empty).toBe(true);
  expect((await notifications(f.personIds[1]).doc(foreign.id).get()).data()?.readAt).toBeNull();
  expect(await markAllNotificationsRead(f.owner,()=>at)).toEqual({ok:true,marked:0});
});
