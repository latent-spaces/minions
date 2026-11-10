import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { beforeEach, afterEach, expect, test } from 'vitest';
import { v2Routes } from '../src/v2/routes.js';
import { resetEmulator, scoped, seed } from './helpers.js';
let at=2_000_000_000_000,server:Server,base:string;
beforeEach(async()=>{await resetEmulator();at=2_000_000_000_000;const app=express();app.use(express.json());app.use('/v2',scoped(v2Routes(()=>at)));server=app.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${(server.address() as AddressInfo).port}/v2`;});
afterEach(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
async function call(token:string,path:string,body:object){const r=await fetch(base+path,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body)});return {status:r.status,retry:r.headers.get('retry-after'),value:await r.json()};}
test('control writes are per agent and shutdown retains a separate bounded allowance',async()=>{
 const f=await seed({profiles:[{name:'Owner',email:'owner@example.test'}],agents:[{person:0,name:'amber'},{person:0,name:'basil'}]});
 const token=f.agents[0].token,other=f.agents[1].token;
 const start=await call(token,'/runs',{client_run_id: randomUUID(), runner_version:'test'});expect(start.status).toBe(200);
 const path=`/runs/${start.value.run_id}/phase`;
 for(let n=0;n<59;n++)expect((await call(token,path,{phase:'idle'})).status).toBe(200);
 const throttled=await call(token,path,{phase:'idle'});expect(throttled.status).toBe(429);expect(Number(throttled.retry)).toBeGreaterThan(0);expect(throttled.value.error).toBe('rate_limited');
 expect((await call(other,'/runs',{client_run_id: randomUUID(), runner_version:'test'})).status).toBe(200);
 expect((await call(token,path,{phase:'stopping',reason:'operator'})).status).toBe(200);
 expect((await call(token,'/runs',{client_run_id: randomUUID(), runner_version:'test'})).status).toBe(429);
 at+=60_001;
 for(let n=0;n<3;n++)expect((await call(token,'/runs',{client_run_id: randomUUID(), runner_version:'test',takeover:true})).status).toBe(200);
 expect((await call(token,'/runs',{client_run_id: randomUUID(), runner_version:'test',takeover:true})).status).toBe(429);
});
