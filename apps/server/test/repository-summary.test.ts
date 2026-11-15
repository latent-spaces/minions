import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { collection, inProject } from '../src/firestore.js';
import { publishGitHubAccess } from '../src/projects/github-access.js';
import { readRepositorySummary } from '../src/view/repository-summary.js';
import { viewRoutes } from '../src/view/routes.js';
import { projects } from '../src/projects/records.js';
import { idTokenFor, resetEmulator, scoped, seed, TEST_PROJECT, testProject } from './helpers.js';

const repository = testProject.repoUrl, at = 1_000_000;
const skip={status:'not_checked' as const,value:null};
const scope = <T>(work: () => T) => inProject(TEST_PROJECT, work);
const read = (time=at) => scope(()=>readRepositorySummary(repository,time));
beforeEach(resetEmulator);
async function fixture(open=4,drafts=1,complete=true,merged=6) {
  const f=await seed({profiles:[{name:'Owner',email:'admin@example.test',role:'owner'}]});
  const person=f.personIds[0];
  await collection<Record<string,unknown>>('ownerRuntimeReadiness').doc(person).set({profileId:person,lastSeenAt:at,protocol:1,version:'test',incarnation:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',platform:'darwin',providers:[]});
  const report={version:1,membershipEpoch:0,projectId:TEST_PROJECT,repository,checkedAt:at,
    account:{status:'ok',value:{login:'local-login'}},access:{status:'ok',value:{role:'read',defaultBranch:'main'}},
    collaborators:skip,invitations:skip,rules:skip,protection:skip,pullRequests:{status:'ok',value:{open,drafts,merged,complete}}};
  await publishGitHubAccess(person,report,()=>at);
  return {person,report};
}
test('unknown without a connector report; complete empty scan proves zero',async()=>{
  await seed();
  expect(await read()).toEqual({status:'unavailable',repository});
  await resetEmulator();
  await fixture(0,0,true,0);
  expect(await read()).toEqual({status:'observed',repository,open:0,merged:0,lastSyncAt:at,syncFailed:false});
});
test('connector counts preserve partial coverage, stale receipts and explicit failures',async()=>{
  const {person,report}=await fixture(500,20,false);
  expect(await read()).toEqual({status:'observed',repository,open:500,merged:6,lastSyncAt:null,syncFailed:false});
  await publishGitHubAccess(person,{...report,checkedAt:at+1,pullRequests:{status:'rate_limited',value:null}},()=>at+1);
  expect(await read(at+1)).toMatchObject({open:500,merged:6,lastSyncAt:null,syncFailed:true});
  await publishGitHubAccess(person,{...report,checkedAt:at+2,pullRequests:{status:'ok',value:{open:2,drafts:0,complete:true}}},()=>at+2);
  expect(await read(at+2)).toMatchObject({open:2,merged:null,lastSyncAt:at+2,syncFailed:false});
  expect(await read(at+600_003)).toMatchObject({lastSyncAt:at+2,syncFailed:true});
});
test('reports stay within repository/project boundaries',async()=>{
  await fixture();
  expect((await inProject('b'.repeat(64),()=>readRepositorySummary(repository,at))).status).toBe('unavailable');
  expect((await scope(()=>readRepositorySummary('https://github.com/other/repo',at))).status).toBe('unavailable');
  await projects.doc(TEST_PROJECT).update({'setup.repoUrl':'https://github.com/other/repo'});
  // The caller normally reads the current repository, but stale caller input is fenced too.
  expect((await read()).status).toBe('unavailable');
});

let server: Server, base: string;
beforeAll(async () => {
  const app = express(); app.use('/view', scoped(viewRoutes(() => at)));
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/view/overview`;
});
afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));
test('overview counters require sign-in and are served after the shared cache is populated', async () => {
  await fixture(1,1);
  const token = await idTokenFor('admin@example.test');
  expect((await fetch(base)).status).toBe(401);
  const read = () => fetch(base, { headers: { authorization: `Bearer ${token}` } });
  const response = await read(); expect(response.status).toBe(200);
  expect((await response.json()).repositorySummary).toMatchObject({ status: 'observed', open: 1, merged: 6 });
});
test('a report without PR support cannot mask a successful count observation',async()=>{
  const {person,report}=await fixture(9,3);
  const {pullRequests,...accessOnly}=report;
  await publishGitHubAccess(person,{...accessOnly,checkedAt:at+1},()=>at+1);
  expect(await read(at+1)).toMatchObject({status:'observed',open:9,merged:6,lastSyncAt:at});
  await publishGitHubAccess(person,{...report,checkedAt:at+2,pullRequests:{status:'ok',value:{open:1,drafts:0,complete:true}}},()=>at+2);
  expect(await read(at+2)).toMatchObject({open:1,merged:null,lastSyncAt:at+2});
});

test('installed open/draft reporters leave merged unknown instead of claiming zero',async()=>{
  const {person,report}=await fixture();
  const {merged,...value}=report.pullRequests.value;
  await publishGitHubAccess(person,{...report,checkedAt:at+1,pullRequests:{status:'ok',value}},()=>at+1);
  expect(await read(at+1)).toMatchObject({status:'observed',open:4,merged:null});
});
