import { beforeEach, expect, test } from 'vitest';
import { agents, inProject } from '../src/firestore.js';
import { saveAgentEnvironment, readAgentEnvironment } from '../src/projects/agent-environment.js';
import { membershipDoc } from '../src/projects/access.js';
import { resetEmulator, seed, TEST_PROJECT, loadAgent } from './helpers.js';
import { idTokenFor, scoped } from './helpers.js';
import express from 'express';
import { projectManagementRoutes } from '../src/projects/routes.js';
import { v2Routes } from '../src/v2/routes.js';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

beforeEach(resetEmulator);
const scope = <T>(fn:()=>T) => inProject(TEST_PROJECT,fn);
const report = { schemaVersion:1 as const, client:'claude' as const, mode:'current_chat' as const, connectorVersion:'test',
  capturedAt:1000, workingFolder:'/private/test/repo', nativeLoading:'unverified' as const, truncated:false,
  sources:[{path:'/private/test/repo/CLAUDE.md', scope:'project' as const, status:'discovered' as const, sha256:'a'.repeat(64)}] };
async function fixture() {
  const data=await seed({ profiles:[{name:'Alice',email:'alice@example.test'},{name:'Admin',email:'admin@example.test' }],agents:[{person:0,name:'Fox'}] });
  const agent=await scope(()=>loadAgent(data.agents[0].agentId)); return { ...data,agent };
}
test('report endpoint accepts metadata only and fences replaced credentials and removed participation',async()=>{
  const x=await fixture();
  await expect(scope(()=>saveAgentEnvironment(x.agent,{...report,contents:'secret'},()=>2000))).rejects.toMatchObject({code:'bad_input'});
  await expect(scope(()=>saveAgentEnvironment(x.agent,{...report,sources:[{...report.sources[0],content:'secret'}]},()=>2000))).rejects.toMatchObject({code:'bad_input'});
  await scope(()=>agents().doc(x.agent.id).update({tokenHash:'changed'}));
  await expect(scope(()=>saveAgentEnvironment(x.agent,report,()=>2000))).rejects.toMatchObject({code:'unauthorized'});
  const current=await scope(()=>loadAgent(x.agent.id));
  await membershipDoc(TEST_PROJECT,x.personIds[0]).update({status:'removed',connectionEpoch:1});
  await expect(scope(()=>saveAgentEnvironment(current,report,()=>2000))).rejects.toMatchObject({code:'unauthorized'});
  await expect(scope(()=>readAgentEnvironment(x.personIds[0],x.agent.id,()=>2000))).rejects.toMatchObject({code:'unauthorized'});
});
test('real HTTP routes publish through agent credentials and keep reads owner-only and uncached',async()=>{
  const x=await fixture(), app=express();
  app.use('/api/projects',projectManagementRoutes(()=>2000)); app.use('/v2',scoped(v2Routes(()=>2000)));
  const server=app.listen(0,'127.0.0.1'); await once(server,'listening');
  const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const posted=await fetch(base+'/v2/environment',{method:'POST',headers:{authorization:`Bearer ${x.agents[0].token}`,'content-type':'application/json'},body:JSON.stringify(report)});
    expect(posted.status).toBe(200); expect(await posted.json()).toMatchObject({receivedAt:2000});
    const path=base+`/api/projects/${TEST_PROJECT}/agents/${x.agent.id}/environment`;
    const ownerToken=await idTokenFor('alice@example.test');
    const own=await fetch(path,{headers:{authorization:`Bearer ${ownerToken}`}});
    expect(own.status).toBe(200); expect(own.headers.get('cache-control')).toBe('no-store'); expect((await own.json()).report).toEqual(report);
    const peer=await fetch(path,{headers:{authorization:`Bearer ${await idTokenFor('admin@example.test')}`}}); expect(peer.status).toBe(403);
    expect((await fetch(path)).status).toBe(401);
  } finally { await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())); }
});
