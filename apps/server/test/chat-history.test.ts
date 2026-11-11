import { indexConversations } from '../scripts/index-conversations.js';
import express from 'express';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { db, inProject, profiles, projectDoc } from '../src/firestore.js';
import { messagesV2 } from '../src/v2/records.js';
import { viewRoutes } from '../src/view/routes.js';
import { publicProjectRoutes } from '../src/projects/public.js';
import { publishCatalog } from '../src/projects/catalog.js';
import { membershipDoc } from '../src/projects/access.js';
import { idTokenFor, resetEmulator, scoped, seed, TEST_PROJECT } from './helpers.js';

let server: Server, base: string;
beforeAll(async () => {
  const app = express();
  app.use('/member', scoped(viewRoutes(() => 10000)));
  app.use('/public/:id', publicProjectRoutes(() => 10000));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
beforeEach(resetEmulator);
const key = (n: number) => `message_${String(n).padStart(3, '0')}`;
async function fixture() {
  const f = await seed({ profiles: [{ name: 'Reader', email: 'reader@example.test' }] });
  const id = f.personIds[0], person = { id, ...(await profiles.doc(id).get()).data()! };
  await inProject(TEST_PROJECT, async () => {
    await projectDoc().update({ ownerProfileId: id });
    const batch = db.batch();
    for (let n = 0; n < 110; n++) batch.set(messagesV2().doc(key(n)), {
      id: key(n), threadId: key(0), agentId: 'writer', agentName: 'Writer', protocol: 2,
      body: `Message ${n}`, createdAt: Math.floor(n / 3), audience: 'project', to: ['project'],
    });
    batch.set(messagesV2().doc('private_root'), { id: 'private_root', threadId: 'private_root', agentId: 'writer', agentName: 'Writer', protocol: 2, body: 'Private', createdAt: 999, audience: 'direct', to: ['recipient'] });
    batch.set(messagesV2().doc('private_reply'), { id: 'private_reply', threadId: key(0), agentId: 'writer', agentName: 'Writer', protocol: 2, body: 'Direct reply', createdAt: 1000, audience: 'direct', to: ['recipient'] });
    await batch.commit(); await indexConversations(TEST_PROJECT);
  });
  await publishCatalog(person, TEST_PROJECT, { client_request_id: 'publish', expected_revision: 0, listed: true, summary: 'History', category: 'games', tags: [] }, () => 10000);
  return { token: await idTokenFor('reader@example.test'), personId: id };
}
async function get(path: string, token?: string) {
  const response = await fetch(base + path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: response.status, data: await response.json() };
}

test('latest thread windows keep tied timestamps chronological and paginate older without duplicates, with project and thread scoped member cursors', async () => {
  const { token } = await fixture();
  for (const [prefix, auth, hasPrivate] of [[`/member`, token, true], [`/public/${TEST_PROJECT}`, undefined, false]] as const) {
    const path = `${prefix}/threads/${key(0)}`;
    const recent = await get(path + '?order=latest', auth);
    expect(recent.status).toBe(200);
    const expected = [...Array.from({ length: 110 }, (_, n) => key(n)), ...(hasPrivate ? ['private_reply'] : [])];
    expect(recent.data.messages.map((m: { id: string }) => m.id)).toEqual(expected.slice(-50));
    const earlier = await get(path + '?order=latest&cursor=' + encodeURIComponent(recent.data.next), auth);
    const oldest = await get(path + '?order=latest&cursor=' + encodeURIComponent(earlier.data.next), auth);
    const all = [...oldest.data.messages, ...earlier.data.messages, ...recent.data.messages].map((m: { id: string }) => m.id);
    expect(all).toEqual(expected);
    expect(new Set(all).size).toBe(expected.length);
    expect(oldest.data.next).toBeNull();
    if(prefix.startsWith('/public'))expect((await get(path + '?cursor=' + encodeURIComponent(recent.data.next), auth)).status).toBe(400);
    expect((await get(`${prefix}/threads/private_root?order=latest&cursor=${encodeURIComponent(recent.data.next)}`, auth)).status).toBe(hasPrivate ? 400 : 404);
    expect((await get(path + '?order=invalid', auth)).status).toBe(400);
  }
});

test('latest history preserves member admission, public direct-message exclusion and publication revocation', async () => {
  const { token, personId } = await fixture();
  expect((await get(`/member/threads/${key(0)}?order=latest`)).status).toBe(401);
  expect((await get(`/public/${TEST_PROJECT}/threads/private_root?order=latest`)).status).toBe(404);
  await inProject(TEST_PROJECT, async () => {
    await projectDoc().update({ ownerProfileId: 'another-owner', 'publication.listed': false });
    await membershipDoc(TEST_PROJECT, personId).update({ status: 'removed' });
  });
  expect((await get(`/member/threads/${key(0)}?order=latest`, token)).status).toBe(404);
  expect((await get(`/public/${TEST_PROJECT}/threads/${key(0)}?order=latest`)).status).toBe(404);
});

test('new steering is member-visible, searchable and readable, while old private and public reads stay excluded',async()=>{
 const f=await fixture();const {conversationEntries}=await import('../src/projects/steering.js');
 const {projectCollection}=await import('../src/firestore.js');const {readChatUnread,markChatRead}=await import('../src/projects/chat-support.js');
 const id='steer_shared_test';
 await inProject(TEST_PROJECT,async()=>{
   await projectCollection('agentSteering/retired/missions').doc('old').set({messages:[{body:'Old private secret'}]});
   await conversationEntries().doc(id).set({id,threadId:id,kind:'steering',agentId:'writer',agentName:'Writer',actorProfileId:f.personId,actorName:'Reader',origin:'local_app',operationId:'11111111-1111-4111-8111-111111111111',missionId:'22222222-2222-4222-8222-222222222222',generation:1,body:'Shared checkpoint guidance',to:['writer'],audience:'direct',createdAt:2000,protocol:2,state:'queued',observedAt:null,receiptSequence:0});
 });
 expect((await get('/member/messages/'+id,f.token)).data.message.sender).toMatchObject({kind:'person',id:f.personId});
 expect((await get('/member/conversations/search?q=checkpoint',f.token)).data.messages.map((m:{id:string})=>m.id)).toEqual([id]);
 expect((await get('/member/conversations/search?q=Old%20private',f.token)).data.messages).toEqual([]);
 expect((await get(`/public/${TEST_PROJECT}/messages/${id}`)).status).toBe(404);
 expect((await get('/member/messages/'+id)).status).toBe(401);
 const person={id:f.personId,...(await profiles.doc(f.personId).get()).data()!};
 expect((await readChatUnread(TEST_PROJECT,person,id,()=>10000)).agents[0].count).toBe(1);
 await markChatRead(TEST_PROJECT,person,{channel:'agent',threadId:id,through:{createdAt:2000,id}});
 expect((await readChatUnread(TEST_PROJECT,person,id,()=>10000)).agents[0].count).toBe(0);
});

test('steering author photos use current public consent in list, thread, message and search reads', async () => {
  const f = await fixture();
  const { conversationEntries } = await import('../src/projects/steering.js');
  // The author is independent of this reader and has no agent ownership record.
  const authorId = 'steering-author', photoId = 'a'.repeat(64), id = 'steer_photo_test';
  await profiles.doc(authorId).set({ name: 'Author', email: 'author@example.test', removedAt: null, photo: { id: photoId, publicConsent: true, publishedAt: 1000 } });
  await inProject(TEST_PROJECT, () => conversationEntries().doc(id).set({
    id, threadId: id, kind: 'steering', agentId: 'writer', agentName: 'Writer', actorProfileId: authorId, actorName: 'Author',
    origin: 'coding_chat', operationId: '11111111-1111-4111-8111-111111111111', missionId: '22222222-2222-4222-8222-222222222222',
    generation: 1, body: 'Photo checkpoint guidance', to: ['writer'], audience: 'direct', createdAt: 2000, protocol: 2,
    state: 'included', observedAt: 2001, receiptSequence: 2,
  }));
  async function senders() {
    const detail = await get('/member/messages/' + id, f.token);
    const thread = await get('/member/threads/' + id, f.token);
    const search = await get('/member/conversations/search?q=Photo', f.token);
    const list = await get('/member/conversations', f.token);
    for (const response of [detail, thread, search, list]) expect(response.status).toBe(200);
    const conversation = list.data.conversations.find((row: { threadId: string }) => row.threadId === id);
    return [detail.data.message.sender, thread.data.messages[0].sender, search.data.messages[0].sender, conversation.first.sender, conversation.latest.sender];
  }
  for (const sender of await senders()) expect(sender).toMatchObject({ kind: 'person', id: authorId, photo: { id: photoId, url: `/api/profiles/${authorId}/photo/${photoId}` } });
  for (const change of [{ 'photo.publicConsent': false }, { 'photo.publicConsent': true, removedAt: 3000 }]) {
    await profiles.doc(authorId).update(change);
    for (const sender of await senders()) expect(sender.photo).toBeNull();
  }
  await profiles.doc(authorId).delete();
  for (const sender of await senders()) expect(sender.photo).toBeNull();
});

test('human unread markers preserve tied message ordering independently of agent threads',async()=>{
  const {humanMessages}=await import('../src/projects/chat-records.js');
  const {readChatUnread,markChatRead}=await import('../src/projects/chat-support.js');
  const fixture=await seed({profiles:[{name:'Reader',email:'reader@example.test'}]});
  const person={id:fixture.personIds[0],...(await profiles.doc(fixture.personIds[0]).get()).data()!};
  const first='a'.repeat(64), second='b'.repeat(64);
  await humanMessages(TEST_PROJECT).doc(first).set({sender:{id:person.id,name:'Reader'},body:'First',createdAt:1000,reply:null,attachments:[]});
  await humanMessages(TEST_PROJECT).doc(second).set({sender:{id:person.id,name:'Reader'},body:'Second',createdAt:1000,reply:null,attachments:[]});
  expect((await readChatUnread(TEST_PROJECT,person,undefined,()=>2000)).human.count).toBe(2);
  await markChatRead(TEST_PROJECT,person,{channel:'human',through:{id:first,createdAt:1000}});
  expect((await readChatUnread(TEST_PROJECT,person,undefined,()=>2000)).human.count).toBe(1);
  await markChatRead(TEST_PROJECT,person,{channel:'human',through:{id:second,createdAt:1000}});
  expect((await readChatUnread(TEST_PROJECT,person,undefined,()=>2000)).human.count).toBe(0);
});

test('Me + my agents preserves all authored conversations for a sole project owner', async () => {
  const { conversationEntries } = await import('../src/projects/steering.js');
  const f = await seed({ profiles: [{ name: 'Solo owner', email: 'solo@example.test' }],
    agents: [{ person: 0, name: 'Builder' }, { person: 0, name: 'Reviewer' }] });
  const token = await idTokenFor('solo@example.test');
  await inProject(TEST_PROJECT, async () => {
    await projectDoc().update({ ownerProfileId: f.personIds[0] });
    // The owner is admitted directly, without needing an additional member row.
    await membershipDoc(TEST_PROJECT, f.personIds[0]).delete();
    for (const [n, agent] of f.agents.entries()) {
      const id = n ? 'solo_reply' : 'solo_root';
      await conversationEntries().doc(id).set({ kind: 'agent_message', id, threadId: 'solo_root',
        agentId: agent.agentId, agentName: n ? 'Reviewer' : 'Builder', protocol: 2,
        body: 'Solo checkpoint ' + n, createdAt: 100 + n, audience: 'direct', to: [f.agents[1 - n].agentId] });
    }
    await conversationEntries().doc('solo_steering').set({ kind: 'steering', id: 'solo_steering', threadId: 'solo_root',
      actorProfileId: f.personIds[0], actorName: 'Solo owner', agentId: f.agents[0].agentId, agentName: 'Builder',
      protocol: 2, body: 'Solo checkpoint guidance', createdAt: 102, audience: 'direct', to: [f.agents[0].agentId],
      origin: 'coding_chat', operationId: 'solo', missionId: 'solo', generation: 1,
      state: 'queued', observedAt: null, receiptSequence: 0 });
  });
  for (const path of ['/conversations', '/threads/solo_root?order=latest', '/conversations/search?q=Solo']) {
    const all = await get('/member' + path, token);
    const mine = await get('/member' + path + (path.includes('?') ? '&' : '?') + 'authors=mine', token);
    expect(all.status).toBe(200);
    expect(mine.status).toBe(200);
    expect(mine.data).toEqual(all.data);
    if (path === '/conversations') expect(mine.data.conversations[0].count).toBe(3);
    else expect(mine.data.messages).toHaveLength(3);
  }
});

test('Me + my agents filters before paging, including mixed threads, search and more than 30 owned agents', async () => {
  const { conversationEntries } = await import('../src/projects/steering.js');
  const f = await seed({ profiles: [{ name: 'Me', email: 'me@example.test' }, { name: 'Other', email: 'other@example.test' }],
    agents: [...Array.from({ length: 31 }, (_, n) => ({ person: 0, name: 'Mine ' + n })), { person: 1, name: 'Other agent' }] });
  const token = await idTokenFor('me@example.test');
  const otherToken = await idTokenFor('other@example.test');
  await inProject(TEST_PROJECT, async () => {
    const batch = db.batch();
    const message = (id: string, threadId: string, agentId: string, createdAt: number) => ({
      kind: 'agent_message' as const, id, threadId, agentId, agentName: agentId, protocol: 2 as const,
      body: 'Checkpoint ' + id, createdAt, audience: 'project' as const, to: ['project'],
    });
    const foreign = f.agents[31].agentId;
    batch.set(conversationEntries().doc('mixed'), message('mixed', 'mixed', foreign, 0));
    for (let n = 0; n < 65; n++) {
      const id = key(n);
      batch.set(conversationEntries().doc(id), message(id, 'mixed', f.agents[n % 31].agentId, 10 + Math.floor(n / 3)));
    }
    batch.set(conversationEntries().doc('other_latest'), message('other_latest', 'mixed', foreign, 900));
    for (let n = 0; n < 24; n++) {
      const id = 'own_thread_' + n;
      batch.set(conversationEntries().doc(id), message(id, id, f.agents[0].agentId, 100 + n));
    }
    for (let n = 0; n < 220; n++) {
      const id = 'foreign_' + n;
      batch.set(conversationEntries().doc(id), message(id, id, foreign, 2000 + n));
    }
    const steering = (id: string, actorProfileId: string, agentId: string) => ({
      ...message(id, id, agentId, 1000), kind: 'steering' as const, actorProfileId, actorName: actorProfileId,
      origin: 'coding_chat' as const, operationId: id, missionId: id, generation: 1,
      state: 'queued' as const, observedAt: null, receiptSequence: 0,
    });
    batch.set(conversationEntries().doc('my_steering'), steering('my_steering', f.personIds[0], foreign));
    batch.set(conversationEntries().doc('other_steering'), steering('other_steering', f.personIds[1], f.agents[0].agentId));
    await batch.commit();
  });
  const first = await get('/member/conversations?authors=mine', token);
  expect(first.status).toBe(200);
  expect(first.data.conversations).toHaveLength(20);
  const second = await get('/member/conversations?authors=mine&cursor=' + encodeURIComponent(first.data.next), token);
  const rows = [...first.data.conversations, ...second.data.conversations];
  expect(rows).toHaveLength(26);
  expect(new Set(rows.map(row => row.threadId)).size).toBe(26);
  expect(second.data.next).toBeNull();
  const mixed = rows.find(row => row.threadId === 'mixed');
  expect(mixed.count).toBe(65);
  expect(mixed.first.id).toBe(key(0));
  expect(mixed.latest.id).toBe(key(64));
  const thread = await get('/member/threads/mixed?authors=mine&order=latest', token);
  expect(thread.data.count).toBe(65);
  expect(thread.data.messages).toHaveLength(50);
  const older = await get('/member/threads/mixed?authors=mine&order=latest&cursor=' + encodeURIComponent(thread.data.next), token);
  expect([...older.data.messages, ...thread.data.messages].map(m => m.id)).toEqual(Array.from({ length: 65 }, (_, n) => key(n)));
  const search = await get('/member/conversations/search?authors=mine&q=Checkpoint', token);
  expect(search.data.messages).toHaveLength(90);
  expect(search.data.messages.some((m: { id: string }) => m.id === 'other_steering')).toBe(false);
  expect(search.data.messages.some((m: { id: string }) => m.id === 'my_steering')).toBe(true);
  expect((await get('/member/conversations?cursor=' + encodeURIComponent(first.data.next), token)).status).toBe(400);
  expect((await get('/member/conversations?authors=mine&cursor=' + encodeURIComponent(first.data.next), otherToken)).status).toBe(400);
  expect((await get('/member/threads/mixed?cursor=' + encodeURIComponent(thread.data.next), token)).status).toBe(400);
  expect((await get('/member/conversations?authors=invalid', token)).status).toBe(400);
  expect((await get('/member/messages/other_latest?authors=mine', token)).status).toBe(404);
  expect((await get('/member/messages/my_steering?authors=mine', token)).status).toBe(200);
});

test('a recipient who never wrote shows its own owner and persona, not the sender\'s', async () => {
  const { conversationEntries } = await import('../src/projects/steering.js');
  const f = await seed({ profiles: [{ name: 'Alice', email: 'alice@example.test' }, { name: 'Bob', email: 'bob@example.test' }],
    agents: [{ person: 0, name: 'Sender' }, { person: 1, name: 'Quiet' }] });
  const token = await idTokenFor('alice@example.test');
  await inProject(TEST_PROJECT, () => conversationEntries().doc('quiet_root').set({ kind: 'agent_message', id: 'quiet_root', threadId: 'quiet_root',
    agentId: f.agents[0].agentId, agentName: 'Sender', protocol: 2, body: 'Hello', createdAt: 100, audience: 'direct', to: [f.agents[1].agentId] }));
  const { data } = await get('/member/conversations', token);
  const message = data.conversations[0].latest;
  expect(message.sender).toMatchObject({ operatorId: f.personIds[0], operatorName: 'Alice', personaChoice: 'default' });
  expect(message.audience.to).toEqual([expect.objectContaining({ id: f.agents[1].agentId, name: 'Quiet', operatorId: f.personIds[1], operatorName: 'Bob', personaChoice: 'default' })]);
});
