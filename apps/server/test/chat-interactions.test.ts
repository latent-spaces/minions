import express from 'express';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { db, inProject, profiles } from '../src/firestore.js';
import { humanChatRoutes } from '../src/projects/chat.js';
import { humanMessages } from '../src/projects/chat-records.js';
import { idTokenFor, resetEmulator, seed, TEST_PROJECT } from './helpers.js';
let clock=10000,server:Server,base:string;
beforeAll(async()=>{const app=express();app.use('/chat',humanChatRoutes(()=>clock));server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;});
afterAll(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
beforeEach(async()=>{clock=10000;await resetEmulator();});
async function fixture(){const f=await seed({profiles:[{name:'Reader',email:'reader@example.test'}]});return {people:await Promise.all(f.personIds.map(async id=>({id,...(await profiles.doc(id).get()).data()!}))),token:await idTokenFor('reader@example.test')};}
async function call(path:string,token?:string,body?:object){const response=await fetch(`${base}/chat/${TEST_PROJECT}${path}`,{method:body?'POST':'GET',headers:{...(token?{authorization:`Bearer ${token}`} : {}),...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,data:await response.json()};}
const key=(n:number)=>n.toString(16).padStart(64,'0');

test('human replies persist with replay intent and direct links; text and filename search continue through historical windows',async()=>{
  const {people:[person],token}=await fixture();
  const first=await call('',token,{client_request_id:randomUUID(),body:'Original question'});expect(first.status).toBe(200);clock+=2001;
  const intent={client_request_id:randomUUID(),body:'Reply',replyTo:first.data.message.id};
  const reply=await call('',token,intent);expect(reply.status).toBe(200);expect(reply.data.message.reply).toMatchObject({id:first.data.message.id,body:'Original question',sender:{id:person.id}});
  expect((await call('',token,intent)).data.replayed).toBe(true);
  expect((await call('',token,{...intent,replyTo:key(9999)})).status).toBe(409);
  expect((await call(`/messages/${reply.data.message.id}`,token)).data.message.reply.id).toBe(first.data.message.id);
  clock+=2001;expect((await call('',token,{client_request_id:randomUUID(),body:'Reply',replyTo:key(9999)})).status).toBe(404);
  await inProject(TEST_PROJECT,async()=>{const batch=db.batch();for(let n=0;n<240;n++)batch.set(humanMessages(TEST_PROJECT).doc(key(n)),{sender:{id:person.id,name:person.name},body:n===2||n===230?'A rare needle':n===1||n===231?'':'Ordinary',createdAt:n,...(n===1||n===231?{attachments:[{id:`file-${n}`,name:'Garden-Blueprint.PDF',contentType:'application/pdf',size:123}]}:{})});await batch.commit();});
  const recent=await call('/search?q=needle',token);expect(recent.status).toBe(200);expect(recent.data.scanned).toBe(200);expect(recent.data.messages.map((m:{id:string})=>m.id)).toEqual([key(230)]);expect(recent.data.next).toBeTruthy();
  const old=await call('/search?q=needle&cursor='+encodeURIComponent(recent.data.next),token);expect(old.data.messages.map((m:{id:string})=>m.id)).toEqual([key(2)]);expect(old.data.next).toBeNull();
  expect((await call('/search?q=other&cursor='+encodeURIComponent(recent.data.next),token)).status).toBe(400);
  const fileRecent=await call('/search?q=blueprint.pdf',token);expect(fileRecent.data.messages.map((m:{id:string})=>m.id)).toEqual([key(231)]);expect(fileRecent.data.messages[0].body).toBe('');
  const fileOlder=await call('/search?q=blueprint.pdf&cursor='+encodeURIComponent(fileRecent.data.next),token);expect(fileOlder.data.messages.map((m:{id:string})=>m.id)).toEqual([key(1)]);expect(fileOlder.data.next).toBeNull();
});

test('a reply quote never ends in half of an emoji',async()=>{
  const {token}=await fixture();
  const first=await call('',token,{client_request_id:randomUUID(),body:'a'.repeat(299)+'😀 tail'});expect(first.status).toBe(200);clock+=2001;
  const reply=await call('',token,{client_request_id:randomUUID(),body:'Reply',replyTo:first.data.message.id});
  expect(reply.data.message.reply.body).toBe('a'.repeat(299));
  expect((await call(`/messages/${reply.data.message.id}`,token)).data.message.reply.body).toBe('a'.repeat(299));
});
