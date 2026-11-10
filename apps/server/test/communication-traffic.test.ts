import express from 'express';
import {once} from 'node:events';
import {afterAll,beforeAll,beforeEach,expect,test} from 'vitest';
import {db,inProject} from '../src/firestore.js';
import {conversationEntries} from '../src/projects/steering.js';
import {decodeCursor,encodeCursor} from '../src/cursor.js';
import {messagesV2} from '../src/v2/records.js';
import {membershipDoc} from '../src/projects/access.js';
import {viewRoutes} from '../src/view/routes.js';
import {idTokenFor,resetEmulator,scoped,seed,TEST_PROJECT} from './helpers.js';

const now=10_000_000;
let server:ReturnType<ReturnType<typeof express>['listen']>,base:string;
beforeAll(async()=>{const app=express();app.use(scoped(viewRoutes(()=>now)));server=app.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;});
afterAll(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
beforeEach(resetEmulator);
const scope=<T>(work:()=>Promise<T>)=>inProject(TEST_PROJECT,work);
async function fixture(){const f=await seed({profiles:[{name:'Reader',email:'traffic-reader@example.test'}]});return {person:f.personIds[0],token:await idTokenFor('traffic-reader@example.test')};}
async function get(path:string,token?:string){const response=await fetch(base+path,{headers:token?{authorization:`Bearer ${token}`}:{}});return {status:response.status,data:await response.json()};}
const agent=(id:string,at=now-1000)=>({id,threadId:id,agentId:'agent-a',agentName:'A',kind:'agent_message' as const,audience:'direct' as const,to:['agent-b'],createdAt:at,protocol:2 as const,body:'Private body that must not reach the graph'});

test('shared human and agent messages use one body-free traffic shape; old private instructions stay excluded',async()=>{
 const f=await fixture();
 await scope(async()=>{
  await conversationEntries().doc('agent').set(agent('agent'));
  await conversationEntries().doc('human').set({...agent('human',now-500),kind:'steering',actorProfileId:f.person,actorName:'Reader',agentId:'agent-a',to:['agent-a'],missionId:'private-mission',generation:1,operationId:'private-operation',origin:'coding_chat',state:'queued',observedAt:null,receiptSequence:0});
  await conversationEntries().doc('broadcast').set({...agent('broadcast',now-300),audience:'project',to:['project']});
  await conversationEntries().doc('future').set(agent('future',now+1));
  await conversationEntries().doc('old').set(agent('old',now-300001));
  await messagesV2().doc('earlier-private').set({...agent('earlier-private'),agentId:'private-person'});
 });
 const result=await get('/communication/traffic',f.token);expect(result.status).toBe(200);
 expect(result.data.traffic).toEqual([
  {id:'broadcast',agentId:'agent-a',to:['project'],audience:'project',createdAt:now-300},
  {id:'human',agentId:`person:${f.person}`,to:['agent-a'],audience:'direct',createdAt:now-500},
  {id:'agent',agentId:'agent-a',to:['agent-b'],audience:'direct',createdAt:now-1000},
 ]);
 expect(JSON.stringify(result.data)).not.toMatch(/body|actorName|missionId|operationId|generation|state|receiptSequence/);
 const thread=await get('/threads/human',f.token);expect(thread.status).toBe(200);
 expect(thread.data.messages[0]).toMatchObject({sender:{id:f.person,kind:'person'},threadId:'human'});
});

test('shared traffic reuses bounded paging and rejects changed frame, project and history-source cursors',async()=>{
 const f=await fixture();
 await scope(async()=>{
  for(let start=0;start<501;start+=250){const batch=db.batch();for(let i=start;i<Math.min(start+250,501);i++){const row=agent(`row-${String(i).padStart(4,'0')}`);batch.set(conversationEntries().doc(row.id),row);batch.set(messagesV2().doc(row.id),row);}await batch.commit();}
 });
 const first=await get('/communication/traffic',f.token);expect(first.data.traffic).toHaveLength(500);expect(first.data.next).toBeTruthy();
 const second=await get('/communication/traffic?cursor='+encodeURIComponent(first.data.next),f.token);
 expect(second.data.traffic).toHaveLength(1);expect(second.data.next).toBeNull();
 expect(new Set([...first.data.traffic,...second.data.traffic].map(m=>m.id)).size).toBe(501);
 expect((await get(`/communication/traffic?at=${now-1}&cursor=${encodeURIComponent(first.data.next)}`,f.token)).status).toBe(400);
 const foreign=decodeCursor(first.data.next)!;foreign[0]='different-project';
 expect((await get('/communication/traffic?cursor='+encodeURIComponent(encodeCursor(foreign)),f.token)).status).toBe(400);
 const history=await get('/communication',f.token);
 expect((await get('/communication/traffic?cursor='+encodeURIComponent(history.data.next),f.token)).status).toBe(400);
 expect((await get('/communication?cursor='+encodeURIComponent(first.data.next),f.token)).status).toBe(400);
 expect((await get('/communication/traffic')).status).toBe(401);
 await membershipDoc(TEST_PROJECT,f.person).update({status:'removed'});
 expect((await get('/communication/traffic',f.token)).status).not.toBe(200);
});
