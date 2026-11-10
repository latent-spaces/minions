import express from 'express';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { inProject } from '../src/firestore.js';
import { messagesV2 } from '../src/v2/records.js';
import { viewRoutes } from '../src/view/routes.js';
import { membershipDoc } from '../src/projects/access.js';
import { idTokenFor, resetEmulator, scoped, seed, TEST_PROJECT } from './helpers.js';
let server:Server, base:string, now=1_000_000;
beforeAll(async()=>{const app=express();app.use(scoped(viewRoutes(()=>now)));server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;});
afterAll(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
beforeEach(async()=>{await resetEmulator();now+=1_000_000;});
async function fixture(){const f=await seed({profiles:[{name:'Reader',email:'reader@example.test'}]});return {id:f.personIds[0],token:await idTokenFor('reader@example.test')};}
async function get(path:string,token?:string){const res=await fetch(base+path,{headers:token?{authorization:`Bearer ${token}`}:{}});return {status:res.status,data:await res.json()};}
async function message(id:string,at:number,audience:'direct'|'project'='direct'){await inProject(TEST_PROJECT,()=>messagesV2().doc(id).set({id,threadId:id,agentId:'writer',agentName:'Writer',protocol:2,body:`Body ${id}`,createdAt:at,audience,to:audience==='project'?['project']:['peer']}));}
test('replay excludes future messages and keeps broadcasts separate from direct edges',async()=>{
 const f=await fixture();await message('old',now-400_000);await message('direct',now-1000);await message('broadcast',now-500,'project');await message('future',now+1);
 const recent=await get('/communication',f.token);expect(recent.status).toBe(200);expect(recent.data.messages.map((m:{id:string})=>m.id)).toEqual(['direct','broadcast']);expect(recent.data.edges).toEqual([{from:'writer',to:'peer',count:1,latestAt:now-1000}]);
 const replay=await get(`/communication?at=${now-5000}&range=all`,f.token);expect(replay.data.messages.map((m:{id:string})=>m.id)).toEqual(['old']);
});
test('history remains membership protected, including cached timeline reads',async()=>{
 const f=await fixture();expect((await get('/communication')).status).toBe(401);expect((await get('/communication/timeline',f.token)).status).toBe(200);
 await membershipDoc(TEST_PROJECT,f.id).update({status:'removed'});
 expect((await get('/communication/timeline',f.token)).status).not.toBe(200);expect((await get('/communication',f.token)).status).not.toBe(200);
});
