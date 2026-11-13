import express from 'express';
import { randomUUID } from 'node:crypto';
import { setAccountDisabled } from '../src/identity/server-sessions.js';
import { beforeAll, afterAll, beforeEach, expect, test } from 'vitest';
import type { Server } from 'node:http';
import { hashToken, newToken } from '../src/auth.js';
import { ownerRoutes, computerConnections, COMPUTER_LIFETIME } from '../src/owner/routes.js';
import { projects } from '../src/community/records.js';
import { configureWorkspace, controlWorkspace } from '../src/projects/store.js';
import { inProject, agents, profiles, db } from '../src/firestore.js';
import { membershipDoc, membershipsOf } from '../src/projects/access.js';
import { seed, resetEmulator, idTokenFor, seedApprovedProject, setTestMembership } from './helpers.js';
let server: Server, base: string, at = 1000;
const now = () => at, PROJECT = 'a'.repeat(64);
beforeAll(async () => { const app = express(); app.use('/api/owner', ownerRoutes(now)); server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r)); base = `http://127.0.0.1:${(server.address() as {port:number}).port}/api/owner`; });
afterAll(async () => { await new Promise<void>(r => server.close(() => r())); });
beforeEach(async () => { at = 1000; await resetEmulator(); });
async function http(path: string, token?: string, body?: object, profileId?: string) { const res = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(profileId ? { 'X-Mlswarm-Profile-Id': profileId } : {}), 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: res.status, body: await res.text().then(t => { try { return JSON.parse(t); } catch { throw new Error(path + ' ' + res.status + ' ' + t); } }) }; }
async function fixture() {
  const { personIds } = await seed({ profiles: [{ name: 'Owner', email: 'owner@example.test' }, { name: 'Other', email: 'other@example.test' }] });
  const firebase = await idTokenFor('owner@example.test'), token = newToken(), poll = newToken(), id = randomUUID();
  expect((await http('/connect', undefined, { requestId: id, pollingSecret: poll, candidateTokenHash: hashToken(token), clientName: 'Test client' })).status).toBe(200);
  return { personIds, firebase, token, poll, id };
}
test('owner MCP configures a private project, edits its versioned Card and requests newcomer beta approval without publishing', async () => {
  const f = await fixture(); await http(`/connect/${f.id}/approve`, f.firebase, { approved: true });
  const profile = f.personIds[0];
  const created = await http('/projects/private', f.token, { githubUrl: 'https://github.com/example/repo', client_request_id:randomUUID(),title:'Team notebook',goal:'Research together',approved:true}, profile);
  expect(created.body.projectPagePath).toMatch(/^\/s\/[A-Za-z0-9_-]{22}$/);
  const id = created.body.id, setup = await http(`/projects/${id}/overview`,f.token);
  expect(setup.status).toBe(200); expect(setup.body.definition.title).toBe('Team notebook');
  const card={client_request_id:randomUUID(),expected_version:setup.body.cardVersion,definition:{...setup.body.definition,goal:'A clearer shared purpose'},approved:true};
  expect((await http(`/projects/${id}/card`,f.token,card)).status).toBe(401);
  expect((await http(`/projects/${id}/card`,f.token,{...card,approved:false},profile)).status).toBe(400);
  expect((await http(`/projects/${id}/card`,f.token,card,profile)).body.version).toBe(2);
  expect((await http(`/projects/${id}/card`,f.token,card,profile)).body.replayed).toBe(true);
  expect((await http(`/projects/${id}/card`,f.token,{...card,client_request_id:randomUUID()},profile)).status).toBe(409);
  const config={client_request_id:randomUUID(),expected_revision:setup.body.revision,repoUrl:'https://github.com/example/notebook',approved:true};
  expect((await http(`/projects/${id}/configure`,f.token,config,profile)).status).toBe(200);
  const after=await http(`/projects/${id}/overview`,f.token);
  expect(after.body.project.repoUrl).toBe(config.repoUrl); expect(after.body.project.started).toBe(false);
  expect((await http(`/projects/${id}/publish`,f.token,{client_request_id:randomUUID(),expected_revision:after.body.revision,approved:true},profile)).status).toBe(403);
  expect((await projects.doc(id).get()).data()!.publication.listed).toBe(false);
});
test('browser approval binds a separate owner capability; polling never returns credentials; another human cannot take it over', async () => {
  const f = await fixture();
  expect((await http(`/connect/${f.id}`, newToken())).status).toBe(401);
  expect((await http('/projects', f.token)).status).toBe(401);
  expect((await http(`/connect/${f.id}/approve`, f.firebase, { approved: true })).status).toBe(200);
  const polled = await http(`/connect/${f.id}`, f.poll);
  expect(polled.body).toMatchObject({ status: 'approved', personId: f.personIds[0] });
  expect(JSON.stringify(polled.body)).not.toContain(f.token);
  const other = await idTokenFor('other@example.test');
  expect((await http(`/connect/${f.id}/approve`, other, { approved: true })).status).toBe(403);
  expect((await http('/projects', f.poll)).status).toBe(401);
  expect((await http('/projects', f.token)).status).toBe(200);
});
test('an approved human creates a private project with its repository, without an existing project or agent', async () => {
  await profiles.doc('private-owner').set({ name: 'Owner', email: 'owner@example.test', removedAt: null });
  const firebase = await idTokenFor('owner@example.test'), token = newToken(), id = randomUUID();
  await http('/connect', undefined, { requestId: id, pollingSecret: newToken(), candidateTokenHash: hashToken(token), clientName: 'Private creator' });
  const body = { githubUrl: 'https://github.com/example/repo', client_request_id: randomUUID(), title: 'Private research', goal: 'Compare ideas.', approved: true };
  expect((await http('/projects/private', token, body, 'private-owner')).status).toBe(401);
  await http(`/connect/${id}/approve`, firebase, { approved: true });
  expect((await http('/projects/private', firebase, body, 'private-owner')).status).toBe(401);
  expect((await http('/projects/private', newToken(), body, 'private-owner')).status).toBe(401);
  expect((await http('/projects/private', token, body)).status).toBe(401);
  expect((await http('/projects/private', token, body, 'other')).status).toBe(401);
  for (const invalid of [{ ...body, approved: false }, { ...body, approved: undefined }, { ...body, ownerProfileId: 'other' }, { ...body, repoUrl: 'https://github.com/example/repo' }, { ...body, encryption: true }]) expect((await http('/projects/private', token, invalid, 'private-owner')).status).toBe(400);
  expect((await projects.get()).size).toBe(0);
  const created = await http('/projects/private', token, body, 'private-owner');
  expect(created.status).toBe(200); expect(created.body).toMatchObject({ status: 'ready_to_start', canStart: true, published: false, startsAgents: false, memberLimit: 10, messageProtection: 'server_readable_v1' });
  const projectId = created.body.id;
  expect((await projects.doc(projectId).get()).data()).toMatchObject({ ownerProfileId: 'private-owner', approval: null, privacy: { visibility: 'private' }, setup: { repoUrl: 'https://github.com/example/repo' }, execution: { started: false } });
  expect((await inProject(projectId, () => agents().get())).size).toBe(0);
  expect((await db.collection('proposals').get()).size).toBe(0);
  expect((await db.collection('projectListings').get()).size).toBe(0);
  expect((await http('/projects/private', token, body, 'private-owner')).body).toMatchObject({ id: projectId, replayed: true, status: 'ready_to_start' });
  expect((await http('/projects/private', token, { ...body, goal: 'Different' }, 'private-owner')).status).toBe(409);
  expect((await projects.get()).size).toBe(1);
  expect((await http('/projects', token)).body.projects).toMatchObject([{ id: projectId, status: 'ready_to_start' }]);
  await profiles.doc('private-owner').update({ removedAt: at });
  await profiles.doc('new-owner').set({ name: 'Replacement', email: 'owner@example.test', removedAt: null });
  expect((await http('/projects/private', token, body, 'new-owner')).status).toBe(401);
  expect((await projects.get()).size).toBe(1);
});
test('owner access expires, is revocable, and refuses a disabled account', async () => {
  const f = await fixture(); await http(`/connect/${f.id}/approve`, f.firebase, { approved: true });
  const c = (await computerConnections.doc(f.id).get()).data()!;
  await setAccountDisabled(c.firebaseUid!, true);
  expect((await http('/projects', f.token)).status).toBe(401);
  await setAccountDisabled(c.firebaseUid!, false);
  expect((await http('/connections/revoke', f.token, {})).body).toEqual({ revoked: true });
  expect((await http('/projects', f.token)).status).toBe(401);
  await resetEmulator(); const f2 = await fixture(); await http(`/connect/${f2.id}/approve`, f2.firebase, { approved: true }); at += COMPUTER_LIFETIME;
  expect((await http('/projects', f2.token)).status).toBe(401);
});
test('only owned projects can be started; a member cannot start them', async () => {
  const f = await fixture(); await http(`/connect/${f.id}/approve`, f.firebase, { approved: true });
  const person = { id: f.personIds[0], ...(await profiles.doc(f.personIds[0]).get()).data()! };
  await seedApprovedProject(PROJECT, { definition: { title: 'Garden', goal: 'Grow together', beneficiaries: 'People', output: 'Garden', scope: 'Small', acceptanceCriteria: 'Review', sources: null, resources: null, mergeApproval: 'humans' }, ownerProfileId: person.id, reviewerProfileId: person.id, submittedRevision: 2, approvedAt: 1, required: false });
  await configureWorkspace(person, PROJECT, { client_request_id: 'configure', expected_revision: 0, repoUrl: 'https://github.com/example/garden' }, now);
  const overview = await http(`/projects/${PROJECT}/overview`, f.token); expect(overview.body.status).toMatchObject({ status: 'not_published', canStart: true, contributorsNeeded: null, startsAgents: false });
  const start = { client_request_id: 'start', expected_revision: 1, action: 'start', approved: true };
  expect((await http(`/projects/${PROJECT}/control`, f.token, start, person.id)).status).toBe(200);
  expect((await http(`/projects/${PROJECT}/control`, f.token, start, person.id)).body.replayed).toBe(true);
  await setTestMembership(PROJECT, f.personIds[1]);
  const otherToken = newToken(), otherPoll = newToken(), id = randomUUID(), otherFirebase = await idTokenFor('other@example.test');
  await http('/connect', undefined, { requestId: id, pollingSecret: otherPoll, candidateTokenHash: hashToken(otherToken), clientName: 'Other' });
  await http(`/connect/${id}/approve`, otherFirebase, { approved: true });
    expect((await http(`/projects/${PROJECT}/control`, otherToken, { client_request_id: 'other', expected_revision: 2, action: 'start', approved: true }, f.personIds[1])).status).toBe(403);
  await controlWorkspace(person, PROJECT, { client_request_id: 'finish', expected_revision: 2, action: 'close' }, now);
  const list = (await http('/projects', f.token)).body;
  expect(list.projects.find((p: {id:string}) => p.id === PROJECT)).toMatchObject({ status: 'closed', state: { next: { actor: 'owner', action: 'reopen_project' } } });
});
async function teamFixture() {
  const f = await fixture(); await http(`/connect/${f.id}/approve`, f.firebase, {approved:true});
  await seedApprovedProject(PROJECT, { definition: { title:'Team',goal:'Build',beneficiaries:'People',output:'App',scope:'Small',acceptanceCriteria:'Review',sources:null,resources:null,mergeApproval:'humans' }, ownerProfileId: f.personIds[0], reviewerProfileId: f.personIds[0], submittedRevision: 1, approvedAt: 1, required: false });
  return f;
}
test('team creation cannot impersonate another owner and validates explicit approval',async()=>{
  const f=await teamFixture(),input={names:['One'],client_request_id:'create',approved:true};
  expect((await http(`/projects/${PROJECT}/agents`,f.token,{...input,approved:false})).status).toBe(400);
  expect((await http(`/projects/${PROJECT}/agents`,f.token,{...input,personId:f.personIds[1]})).status).toBe(400);
  await projects.doc(PROJECT).update({ownerProfileId:f.personIds[1]});
  await membershipDoc(PROJECT,f.personIds[0]).set({ projectId: PROJECT, role: 'member', revision: 1, updatedAt: at, connectionEpoch: 0, profileId: f.personIds[0], status: 'active', statusChangedAt: 0, restrictions: { chatMutedUntil: null } });
  expect((await http(`/projects/${PROJECT}/agents`,f.token,input)).status).toBe(403);
  await inProject(PROJECT,async()=>expect((await agents().get()).size).toBe(0));
});
async function computer(email = 'owner@example.test') {
  const { personIds } = await seed({ profiles: [{ name: 'Owner', email: 'owner@example.test' }, { name: 'Other', email: 'other@example.test' }] });
  const firebase = await idTokenFor(email), token = newToken(), id = randomUUID();
  expect((await http('/connect', undefined, { requestId: id, pollingSecret: newToken(), candidateTokenHash: hashToken(token), clientName: 'Test client' })).status).toBe(200);
  expect((await http(`/connect/${id}/approve`, firebase, { approved: true })).status).toBe(200);
  return { personIds, firebase, token, id };
}
test('an approved computer outlasts a day, is listed for its person only, and ends when they revoke it on the website', async () => {
  const c = await computer(); at += 24 * 60 * 60_000 + 1;
  expect((await http('/member-projects', c.token)).status).toBe(200);
  expect((await http('/computers', c.firebase)).body.computers).toMatchObject([{ id: c.id, clientName: 'Test client' }]);
  const other = await idTokenFor('other@example.test');
  expect((await http('/computers', other)).body.computers).toEqual([]);
  expect((await http(`/computers/${c.id}/revoke`, other, {})).status).toBe(401);
  expect((await http('/member-projects', c.token)).status).toBe(200);
  expect((await http(`/computers/${c.id}/revoke`, c.firebase, {})).body).toEqual({ revoked: true });
  expect((await http('/member-projects', c.token)).status).toBe(401);
  expect((await http('/computers', c.firebase)).body.computers).toEqual([]);
  await resetEmulator(); at = 1000; const later = await computer(); at += COMPUTER_LIFETIME;
  expect((await http('/member-projects', later.token)).status).toBe(401);
});

test('owner quotas follow verified people across computers, not proxy sockets or forwarded headers', async () => {
  const f = await fixture(); await http(`/connect/${f.id}/approve`, f.firebase, { approved: true });
  const secondToken = newToken(), secondId = randomUUID();
  await http('/connect', undefined, { requestId: secondId, pollingSecret: newToken(), candidateTokenHash: hashToken(secondToken), clientName: 'Second computer' });
  await http(`/connect/${secondId}/approve`, f.firebase, { approved: true });
  const otherFirebase = await idTokenFor('other@example.test'), otherToken = newToken(), otherId = randomUUID();
  await http('/connect', undefined, { requestId: otherId, pollingSecret: newToken(), candidateTokenHash: hashToken(otherToken), clientName: 'Other person' });
  await http(`/connect/${otherId}/approve`, otherFirebase, { approved: true });
  // Both browser approvals used the same verified-person window; fill its remaining allowance.
  for (let n = 0; n < 58; n++) expect((await http('/projects', f.token)).status).toBe(200);
  expect((await http('/projects', secondToken)).status).toBe(429);
  expect((await http('/projects', otherToken)).status).toBe(200);
  const spoof = await fetch(base + '/projects', { headers: { authorization: `Bearer ${f.token}`, 'x-forwarded-for': '203.0.113.77' } });
  expect(spoof.status).toBe(429); expect(Number(spoof.headers.get('retry-after'))).toBeGreaterThan(0);
});


test('MCP lifecycle endpoint fences approval and selected account and reopens without starting work',async()=>{
 const f=await fixture();await http(`/connect/${f.id}/approve`,f.firebase,{approved:true});
 const profile=f.personIds[0];
 const created=await http('/projects/private',f.token,{ githubUrl: 'https://github.com/example/repo', client_request_id:randomUUID(),title:'Lifecycle via MCP',goal:'Chat',approved:true},profile);
 const id=created.body.id,close={client_request_id:'close-via-mcp',expected_revision:0,action:'close',approved:true};
 expect((await http(`/projects/${id}/control`,f.token,close)).status).toBe(401);
 expect((await http(`/projects/${id}/control`,f.token,{...close,approved:false},profile)).status).toBe(400);
 expect((await http(`/projects/${id}/control`,f.token,{...close,action:'delete'},profile)).status).toBe(400);
 expect((await http(`/projects/${id}/control`,f.token,close,profile)).body).toMatchObject({execution:'closed',revision:1});
 expect((await http(`/projects/${id}/control`,f.token,close,profile)).body).toMatchObject({replayed:true,revision:1});
 expect((await http(`/projects/${id}/overview`,f.token)).body.status).toMatchObject({status:'closed',startsAgents:false});
 expect((await http(`/projects/${id}/control`,f.token,{...close,action:'reopen',expected_revision:1,client_request_id:'reopen-via-mcp'},profile)).body).toMatchObject({execution:'ready',revision:2});
 expect((await http(`/projects/${id}/overview`,f.token)).body).toMatchObject({project:{repoUrl:'https://github.com/example/repo'},revision:2});
});

test('human MCP Needs you uses the approved account and explicit answer contract',async()=>{
 const f=await fixture();await http(`/connect/${f.id}/approve`,f.firebase,{approved:true});
 const {TEST_PROJECT}=await import('./helpers.js');
 const {startRun}=await import('../src/v2/runs.js');
 const {requestHuman}=await import('../src/projects/human-requests.js');
 const {addAgent}=await import('./helpers.js');
 const agent=await addAgent(f.personIds[0],'scout',()=>1000);
 const run=await inProject(TEST_PROJECT,()=>startRun(agent.agentId,{clientRunId: randomUUID(), runnerVersion:'test',takeover:false},()=>1000));
 const request=(await inProject(TEST_PROJECT,()=>requestHuman(agent.agentId,run.run_id,{dedupe_key:'help',visibility:'private',title:'Research help',question:'Which source should I use?',context:'The required source is inaccessible; the approved source refused access.',suggested_options:['Use the existing approved source.']},()=>1100))).request;
 expect((await http('/needs-you',f.token)).body.items[0].id).toBe(request.id);
 const answer={expected_revision:1,client_request_id:'reply',option_index:0,approved:true};
 expect((await http(`/needs-you/${request.id}/answer`,f.token,answer)).status).toBe(401);
 expect((await http(`/needs-you/${request.id}/answer`,f.token,{...answer,approved:false},f.personIds[0])).status).toBe(400);
 expect((await http(`/needs-you/${request.id}/answer`,f.token,answer,f.personIds[0])).body.request).toMatchObject({status:'answered',answer:{body:'Use the existing approved source.',optionIndex:0}});
 expect((await http(`/needs-you/${request.id}/answer`,f.token,answer,f.personIds[0])).body.replayed).toBe(true);
});


test('project listing includes only existing owned/joined memberships, with explicit filters and no owner setup leak', async () => {
 const f=await fixture();await http(`/connect/${f.id}/approve`,f.firebase,{approved:true});
 const owner=f.personIds[0], other=f.personIds[1], joined='b'.repeat(64), admin='c'.repeat(64), outsider='d'.repeat(64);
 const definition={title:'Shared work',goal:'Build',beneficiaries:'People',output:'App',scope:'Small',acceptanceCriteria:'Review',sources:null,resources:null,mergeApproval:'humans' as const};
 for(const id of [PROJECT,joined,admin,outsider])await seedApprovedProject(id,{definition,ownerProfileId:id===PROJECT?owner:other,reviewerProfileId:owner,submittedRevision:1,approvedAt:1,required:false});
 for(const [projectId,role] of [[joined,'member'],[admin,'admin']] as const) {
  const member={projectId,role,revision:1,updatedAt:at,connectionEpoch:0,profileId:owner,status:'active' as const,statusChangedAt:0,restrictions:{chatMutedUntil:null}};
  await membershipDoc(projectId,owner).set(member);await membershipsOf(owner).doc(projectId).set(member);
 }
 const all=await http('/projects',f.token);expect(all.status).toBe(200);
 expect(all.body.projects.map((p:{id:string})=>p.id)).toEqual(expect.arrayContaining([PROJECT,joined,admin]));
 expect(all.body.projects.some((p:{id:string})=>p.id===outsider)).toBe(false);
 for(const id of [joined,admin]) {
  const row=all.body.projects.find((p:{id:string})=>p.id===id);
  expect(row).toHaveProperty('status');expect(row).toHaveProperty('nextStep');
  for(const key of ['project','definition','setup','blockers','canStart','canStartWithFewer','governance'])expect(row).not.toHaveProperty(key);
 }
 expect((await http('/projects?scope=owned',f.token)).body.projects.map((p:{id:string})=>p.id)).toEqual([PROJECT]);
 expect((await http('/projects?scope=joined',f.token)).body.projects.every((p:{role:string})=>p.role!=='owner')).toBe(true);
 expect((await http('/projects?scope=other',f.token)).status).toBe(400);
 expect((await http('/projects?ownerProfileId=other',f.token)).status).toBe(400);
 expect((await fetch(base+`/projects/${PROJECT}/start`,{method:'POST',headers:{authorization:`Bearer ${f.token}`,'content-type':'application/json'},body:JSON.stringify({client_request_id:'retired',expected_revision:0})})).status).toBe(404);
});

test('steering rejects a token/profile mismatch before accepting any message',async()=>{
 const f=await fixture();await http(`/connect/${f.id}/approve`,f.firebase,{approved:true});
 const response=await http(`/projects/${PROJECT}/steering`,f.token,{operationId:randomUUID(),agentId:'agent',missionId:randomUUID(),generation:1,body:'Do not accept',origin:'local_app'},f.personIds[1]);
 expect(response.status).toBe(401);expect((await db.collectionGroup('conversationEntries').get()).size).toBe(0);
 const retiredOrigin=await http(`/projects/${PROJECT}/steering`,f.token,{operationId:randomUUID(),agentId:'agent',missionId:randomUUID(),generation:1,body:'Retired producer',origin:'local_app'},f.personIds[0]);
 expect(retiredOrigin.status).toBe(400);expect((await db.collectionGroup('conversationEntries').get()).size).toBe(0);
});

test('member MCP reads the versioned Card without gaining owner-only edit or setup actions',async()=>{
  const f=await fixture(); await http(`/connect/${f.id}/approve`,f.firebase,{approved:true});
  const owner=f.personIds[0], member=f.personIds[1];
  const created=await http('/projects/private',f.token,{githubUrl:'https://github.com/example/member-card',client_request_id:randomUUID(),title:'Member Card',goal:'Shared boundaries',approved:true},owner);
  const id=created.body.id;
  const membership={profileId:member,projectId:id,role:'member' as const,status:'active' as const,statusChangedAt:0,restrictions:{chatMutedUntil:null},revision:1,updatedAt:at,connectionEpoch:0};
  await membershipDoc(id,member).set(membership);await membershipsOf(member).doc(id).set(membership);
  const token=newToken(),connectionId=randomUUID(),firebase=await idTokenFor('other@example.test');
  await http('/connect',undefined,{requestId:connectionId,pollingSecret:newToken(),candidateTokenHash:hashToken(token),clientName:'Member computer'});
  await http(`/connect/${connectionId}/approve`,firebase,{approved:true});
  const setup=await http(`/projects/${id}/overview`,token);
  expect(setup.status).toBe(200);expect(setup.body.role).toBe('member');
  const change={client_request_id:randomUUID(),expected_version:setup.body.cardVersion,definition:{...setup.body.definition,mergeApproval:'humans'},approved:true};
  expect((await http(`/projects/${id}/card`,token,change,owner)).status).toBe(401);
  expect((await http(`/projects/${id}/card`,token,change,member)).status).toBe(403);
  const request={client_request_id:randomUUID(),expected_revision:setup.body.revision,approved:true};
  expect((await http(`/projects/${id}/configure`,token,{...request,repoUrl:'https://github.com/example/other'},member)).status).toBe(403);
  expect((await http(`/projects/${id}/publish`,token,request,member)).status).toBe(403);
  const {addAgent}=await import('./helpers.js');
  const worker=await inProject(id,()=>addAgent(member,'worker',now));
  expect((await http(`/projects/${id}/overview`,worker.token)).status).toBe(401);
  await membershipDoc(id,member).update({status:'removed'});
  expect((await http(`/projects/${id}/overview`,token)).status).toBe(404);
  expect((await http(`/projects/${id}/card`,token,change,member)).status).toBe(401);
});

test('retired local browser owner endpoints are absent even for an approved computer', async () => {
  const f = await fixture(); await http(`/connect/${f.id}/approve`, f.firebase, { approved: true });
  for (const path of ['waiting-room', 'task-directory', 'native-task-settings', 'tasks', 'tasks/synthetic-task']) {
    for (const method of path.startsWith('tasks') ? ['POST'] : ['GET', 'POST']) {
      const result = await fetch(`${base}/projects/${PROJECT}/${path}`, { method,
        headers: { authorization: `Bearer ${f.token}`, 'X-Mlswarm-Profile-Id': f.personIds[0], 'content-type': 'application/json' },
        ...(method === 'POST' ? { body: '{}' } : {}) });
      expect(result.status).toBe(404);
    }
  }
});

test('revoking a computer revokes its agents and runs across projects, preserving other computers and people', async () => {
  const f = await fixture(); await http(`/connect/${f.id}/approve`, f.firebase, { approved: true });
  const profileId = f.personIds[0], secondId = randomUUID(), secondToken = newToken();
  await http('/connect', undefined, { requestId: secondId, pollingSecret: newToken(), candidateTokenHash: hashToken(secondToken), clientName: 'Second computer' });
  await http(`/connect/${secondId}/approve`, f.firebase, { approved: true });
  const secondProject = 'c'.repeat(64);
  await seedApprovedProject(secondProject, { ownerProfileId: profileId, required: false,
    definition: { title: 'Second project', goal: 'Build', beneficiaries: 'People', output: 'Evidence', scope: 'Small', acceptanceCriteria: 'Tests', sources: null, resources: null, mergeApproval: 'humans' } });
  const { seedRuntime } = await import('./helpers.js');
  await seedRuntime(secondProject, { started: true });
  const connect = async (projectId: string, token: string, name: string, candidate = newToken()) => {
    const input = { name, candidateTokenHash: hashToken(candidate), clientName: 'same display name', folder: 'C:\\Synthetic folder\\agent' };
    const result = await http(`/projects/${projectId}/agents/connect`, token, input);
    expect(result.status).toBe(200);
    return { agentId: result.body.agentId as string, token: candidate, input, projectId };
  };
  const { TEST_PROJECT, addAgent } = await import('./helpers.js');
  const { agentByToken } = await import('../src/store/profiles.js');
  const { assertAgentMembership } = await import('../src/projects/access.js');
  const { startRun } = await import('../src/v2/runs.js');
  const first = await connect(TEST_PROJECT, f.token, 'first'), second = await connect(secondProject, f.token, 'second');
  const preserved = await connect(TEST_PROJECT, secondToken, 'preserved');
  const other = await inProject(TEST_PROJECT, () => addAgent(f.personIds[1], 'other-person', now));
  for (const item of [first, second]) {
    expect((await db.doc(`projects/${item.projectId}/agents/${item.agentId}`).get()).data()!.computerConnectionId).toBe(f.id);
    await inProject(item.projectId, () => startRun(item.agentId, { clientRunId: randomUUID(), runnerVersion: 'synthetic', takeover: false }, now));
  }
  // Binding is exact even when computer display names and folders are identical.
  expect((await http(`/projects/${TEST_PROJECT}/agents/connect`, secondToken, first.input)).status).toBe(409);
  const otherFirebase = await idTokenFor('other@example.test');
  expect((await http(`/computers/${f.id}/revoke`, otherFirebase, {})).status).toBe(401);
  expect((await http(`/computers/${f.id}/revoke`, f.token, {})).status).toBe(401);
  expect((await http(`/computers/${f.id}/revoke`, f.firebase, {})).body).toEqual({ revoked: true });
  for (const item of [first, second]) {
    expect((await db.doc(`projects/${item.projectId}/agents/${item.agentId}`).get()).data()!.revokedAt).toBe(at);
    // One status-document write: the run group marked stopping and the agent group (A1) written whole.
    expect((await db.doc(`projects/${item.projectId}/presence/${item.agentId}`).get()).data())
      .toMatchObject({ phase: 'stopping', phaseAt: at, agent: { revokedAt: at, name: item.input.name } });
    expect((await db.doc(`projects/${item.projectId}/runs/${item.agentId}`).get()).data()).toMatchObject({ endedAt: at, endReason: 'computer_revoked' });
    expect(await inProject(item.projectId, () => agentByToken(item.token))).toBeNull();
    await expect(inProject(item.projectId, () => db.runTransaction(tx => assertAgentMembership(tx, item.agentId)))).rejects.toMatchObject({ code: 'unauthorized' });
  }
  expect(await inProject(TEST_PROJECT, () => agentByToken(preserved.token))).not.toBeNull();
  expect(await inProject(TEST_PROJECT, () => agentByToken(other.token))).not.toBeNull();
  expect((await http('/projects', f.token)).status).toBe(401);
  expect((await http(`/projects/${TEST_PROJECT}/agents/connect`, f.token, first.input)).status).toBe(401);
  expect((await http('/computers', f.firebase)).body.computers.map((c: { id: string }) => c.id)).toEqual([secondId]);
  expect((await http(`/computers/${f.id}/revoke`, f.firebase, {})).status).toBe(200);
  expect((await http(`/projects/${TEST_PROJECT}/agents/connect`, secondToken, first.input)).status).toBe(409);
  expect((await http(`/projects/${TEST_PROJECT}/agents/connect`, secondToken, { ...first.input, candidateTokenHash: hashToken(newToken()) })).status).toBe(200);
  expect(await inProject(TEST_PROJECT, () => agentByToken(first.token))).toBeNull();
  expect((await db.doc(`projects/${TEST_PROJECT}/agents/${first.agentId}`).get()).data()!.revokedAt).toBe(at);
});

test('computer grant fences tokens and writes before paginated revocation finishes, and pending cleanup can be retried', async () => {
  const f = await fixture(); await http(`/connect/${f.id}/approve`, f.firebase, { approved: true });
  const { TEST_PROJECT, addAgent } = await import('./helpers.js');
  const { agentByToken } = await import('../src/store/profiles.js');
  const { assertAgentMembership } = await import('../src/projects/access.js');
  const item = await inProject(TEST_PROJECT, () => addAgent(f.personIds[0], 'pending', now));
  await db.doc(`projects/${TEST_PROJECT}/agents/${item.agentId}`).update({ computerConnectionId: f.id });
  await computerConnections.doc(f.id).update({ revokedAt: at, revocationCompleteAt: null });
  expect(await inProject(TEST_PROJECT, () => agentByToken(item.token))).toBeNull();
  await expect(inProject(TEST_PROJECT, () => db.runTransaction(tx => assertAgentMembership(tx, item.agentId)))).rejects.toMatchObject({ code: 'unauthorized' });
  expect((await http('/computers', f.firebase)).body.computers).toEqual([]);
  expect((await http('/computers?includeRevoking=true', f.firebase)).body.computers[0]).toMatchObject({ id: f.id, revocationPending: true });
  expect((await http(`/computers/${f.id}/revoke`, f.firebase, {})).status).toBe(200);
  expect((await db.doc(`projects/${TEST_PROJECT}/agents/${item.agentId}`).get()).data()!.revokedAt).toBe(at);
  expect((await http('/computers?includeRevoking=true', f.firebase)).body.computers).toEqual([]);
});

test('legacy computer associations require exact runtime evidence before revocation', async () => {
  const f = await fixture(); await http(`/connect/${f.id}/approve`, f.firebase, { approved: true });
  const { TEST_PROJECT, addAgent } = await import('./helpers.js');
  const item = await inProject(TEST_PROJECT, () => addAgent(f.personIds[0], 'older', now));
  const path = `projects/${TEST_PROJECT}/agents/${item.agentId}`;
  const refused = await http(`/computers/${f.id}/revoke`, f.firebase, {});
  expect(refused.status).toBe(409); expect(refused.body.message).toContain('does not identify its computer');
  expect((await computerConnections.doc(f.id).get()).data()!.revokedAt).toBeNull();
  await db.doc(`projects/${TEST_PROJECT}/backgroundControls/${item.agentId}`).set({
    target: { ownerId: f.personIds[0], projectId: TEST_PROJECT, agentId: item.agentId }, connectionId: f.id, deviceLastSeenAt: at,
  });
  expect((await http(`/computers/${f.id}/revoke`, f.firebase, {})).status).toBe(200);
  expect((await db.doc(path).get()).data()).toMatchObject({ computerConnectionId: f.id, revokedAt: at });
});

test('computer revocation pages through more than one hundred agents without needing current project membership', async () => {
  const f = await fixture(); await http(`/connect/${f.id}/approve`, f.firebase, { approved: true });
  const { TEST_PROJECT } = await import('./helpers.js');
  const batch = db.batch();
  for (let n = 0; n < 102; n++) batch.set(db.doc(`projects/${TEST_PROJECT}/agents/bulk-${String(n).padStart(3, '0')}`), {
    ownerProfileId: f.personIds[0], name: `bulk-${n}`, tokenHash: hashToken(newToken()), tokenIssuedAt: at, createdAt: at,
    revokedAt: null, connectionEpoch: 0, computerConnectionId: f.id,
  });
  await batch.commit();
  await membershipDoc(TEST_PROJECT, f.personIds[0]).update({ status: 'left' });
  expect((await http(`/computers/${f.id}/revoke`, f.firebase, {})).status).toBe(200);
  const all = await db.collection(`projects/${TEST_PROJECT}/agents`).get();
  expect(all.size).toBe(102); expect(all.docs.every(row => row.data().revokedAt === at)).toBe(true);
}, 30_000);


test('verified credential replay binds an older registration and approval expiry alone does not revoke its agent', async () => {
  const f = await fixture(); await http(`/connect/${f.id}/approve`, f.firebase, { approved: true });
  const { TEST_PROJECT, addAgent } = await import('./helpers.js');
  const { agentByToken } = await import('../src/store/profiles.js');
  const item = await inProject(TEST_PROJECT, () => addAgent(f.personIds[0], 'replay-old', now));
  const response = await http(`/projects/${TEST_PROJECT}/agents/connect`, f.token, {
    name: 'replay-old', agentId: item.agentId, candidateTokenHash: hashToken(item.token), clientName: 'Synthetic', folder: '/tmp/synthetic-agent',
  });
  expect(response.status).toBe(200); expect(response.body.replayed).toBe(true);
  expect((await db.doc(`projects/${TEST_PROJECT}/agents/${item.agentId}`).get()).data()!.computerConnectionId).toBe(f.id);
  at += COMPUTER_LIFETIME;
  expect((await http('/projects', f.token)).status).toBe(401);
  expect(await inProject(TEST_PROJECT, () => agentByToken(item.token))).not.toBeNull();
  expect((await http(`/computers/${f.id}/revoke`, f.firebase, {})).status).toBe(200);
  expect(await inProject(TEST_PROJECT, () => agentByToken(item.token))).toBeNull();
});
