import { beforeEach, expect, test, vi } from 'vitest';
import type { GitHubAccessReport } from '@mlswarm/contracts';
import { collection, db, profiles } from '../src/firestore.js';
import { membershipDoc, membershipsOf } from '../src/projects/access.js';
import { projects } from '../src/projects/records.js';
import { publishGitHubAccess } from '../src/projects/github-access.js';
import { readMergingAccess } from '../src/projects/merging.js';
import { repositoryAccess } from '../src/projects/github-username.js';
import { resetEmulator, seed, TEST_PROJECT } from './helpers.js';
const at=1_000_000, connection='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const computers=collection<Record<string,unknown>>('computerConnections');
const skip={status:'not_checked' as const,value:null};
const report=(checkedAt=at):GitHubAccessReport=>({version:1,membershipEpoch:0,projectId:TEST_PROJECT,repository:'https://github.com/example/game',checkedAt,
  account:{status:'ok',value:{login:'local-login'}},access:{status:'ok',value:{role:'write',defaultBranch:'main'}},
  collaborators:skip,invitations:skip,rules:skip,protection:skip});
beforeEach(resetEmulator);
// The owner observes for the whole project; a member observes only their own access.
let ownerId='seed-owner';
async function fixture(role:'owner'|'member'='owner') {
  const f=await seed({profiles:[{name:'Observer',email:'observer@example.test',role}]});
  ownerId=role==='owner'?f.personIds[0]:'seed-owner';
  if(role==='member') await profiles.doc('seed-owner').set({name:'Owner',email:'owner@example.test',removedAt:null});
  await computers.doc(connection).set({profileId:f.personIds[0],approvedAt:1,revokedAt:null,connectionExpiresAt:at+100000});
  return f.personIds[0];
}
const read=()=>readMergingAccess(ownerId,TEST_PROJECT,{},()=>at+5000);
test('targets keep invitation sync inputs and identify observation scope',async()=>{
  const person=await fixture('member');
  const access=await repositoryAccess(person);
  expect(access.joined).toEqual(['https://github.com/example/game']);
  expect(access.observations).toEqual([{projectId:TEST_PROJECT,repository:'https://github.com/example/game',scope:'self',membershipEpoch:0}]);
});
test('removal after membership discovery excludes repository invitation acceptance targets',async()=>{
  const person=await fixture('member');
  const originalRun=db.runTransaction.bind(db);
  // The mirror query has already completed when current membership is checked.
  // Commit both removal records atomically, as normal removal does.
  const transaction=vi.spyOn(db,'runTransaction').mockImplementationOnce(async(work,options)=>{
    const batch=db.batch();
    batch.update(membershipDoc(TEST_PROJECT,person),{status:'removed'});
    batch.update(membershipsOf(person).doc(TEST_PROJECT),{status:'removed'});
    await batch.commit();
    return originalRun(work,options);
  });
  try {
    const access=await repositoryAccess(person);
    expect(transaction).toHaveBeenCalledOnce();
    expect(access.joined).toEqual([]);
    expect(access.observations).toEqual([]);
  } finally { transaction.mockRestore(); }
});
test('failed fields retain their last successful values and account switches clear old facts',async()=>{
  const person=await fixture();
  await publishGitHubAccess(person,connection,report(),()=>at);
  const failed={...report(at+1000),access:{status:'forbidden' as const,value:null}};
  await publishGitHubAccess(person,connection,failed,()=>at+1000);
  let observation=(await read()).github.project!;
  expect(observation.access).toEqual({status:'forbidden',value:{role:'write',defaultBranch:'main'},lastSuccessAt:at});
  expect(observation.observer).toEqual({id:person,name:'Observer'});
  expect(observation.online).toBe(false);
  await publishGitHubAccess(person,connection,{...failed,checkedAt:at+2000,account:{status:'ok',value:{login:'other-login'}}},()=>at+2000);
  observation=(await read()).github.project!;
  expect(observation.access).toEqual({status:'forbidden',value:null,lastSuccessAt:null});
  expect(observation.account.value).toEqual({login:'other-login'});
});
test('member may report their own account but cannot publish shared repository lists',async()=>{
  const person=await fixture('member');
  await publishGitHubAccess(person,connection,report(),()=>at);
  expect((await read()).github.project).toBeNull();
  expect((await read()).github.self[0].scope).toBe('self');
  await expect(publishGitHubAccess(person,connection,{...report(at+1),collaborators:{status:'ok',value:{people:[],complete:true}}},()=>at+1)).rejects.toThrow();
});
test('repository changes and revoked computers exclude cached observations',async()=>{
  const person=await fixture();
  await publishGitHubAccess(person,connection,report(),()=>at);
  await computers.doc(connection).update({revokedAt:at+1});
  expect((await read()).github.project).toBeNull();
  await expect(publishGitHubAccess(person,connection,report(at+1),()=>at+1)).rejects.toThrow();
  await computers.doc(connection).update({revokedAt:null});
  await projects.doc(TEST_PROJECT).update({'setup.repoUrl':'https://github.com/example/changed'});
  expect((await read()).github.project).toBeNull();
  await expect(publishGitHubAccess(person,connection,report(at+2),()=>at+2)).rejects.toThrow();
});
test('strict report validation rejects raw extras, inconsistent values, stale dates and oversized lists',async()=>{
  const person=await fixture();
  for(const value of [{...report(),token:'secret'}, {...report(),account:{status:'ok',value:null}}, {...report(),account:{status:'signed_out',value:null}},report(at-600001),report(at+30001),
    {...report(),collaborators:{status:'ok',value:{people:Array.from({length:101},()=>({login:'member',role:'write'})),complete:false}}}])
    await expect(publishGitHubAccess(person,connection,value,()=>at)).rejects.toThrow();
});
test('removal and expired approvals never expose cached reports',async()=>{
  const person=await fixture('member');
  await publishGitHubAccess(person,connection,{...report(),access:{status:'ok',value:{role:'write',defaultBranch:'main'}}},()=>at);
  expect((await read()).github.project).toBeNull();
  await membershipDoc(TEST_PROJECT,person).update({status:'removed'});
  expect((await read()).github.self).toEqual([]);
  await expect(publishGitHubAccess(person,connection,report(at+1),()=>at+1)).rejects.toThrow();
});
test('online status follows matching current runtime identity and source scanning stays bounded',async()=>{
  const person=await fixture();
  await publishGitHubAccess(person,connection,report(),()=>at);
  const readiness=collection<Record<string,unknown>>('ownerRuntimeReadiness');
  await readiness.doc(connection).set({profileId:person,connectionId:connection,lastSeenAt:at+4000,protocol:1,version:'test',incarnation:connection,platform:'darwin',providers:[]});
  expect((await read()).github.project?.online).toBe(true);
  await readiness.doc(connection).update({profileId:'another-person'});
  expect((await read()).github.project?.online).toBe(false);
  const records=collection<Record<string,unknown>>(`projects/${TEST_PROJECT}/githubAccess`);
  const stored=(await records.doc(connection).get()).data()!;
  await Promise.all(Array.from({length:51},(_,index)=>records.doc(`source-${index}`).set({...stored,connectionId:`source-${index}`})));
  expect((await read()).github.more).toBe(true);
});
test('a changed default branch clears failed cached rules and protection for the earlier branch',async()=>{
  const person=await fixture();
  const previous={...report(),rules:{status:'ok' as const,value:{types:['pull_request'],requiredApprovals:2,requiredChecks:['build'],complete:true}},
    protection:{status:'ok' as const,value:{requiredApprovals:2,requiredChecks:['build'],pullRequests:true,enforceAdmins:true}}};
  await publishGitHubAccess(person,connection,previous,()=>at);
  await publishGitHubAccess(person,connection,{...report(at+1000),access:{status:'ok',value:{role:'write',defaultBranch:'trunk'}},
    rules:{status:'forbidden',value:null},protection:{status:'unavailable',value:null}},()=>at+1000);
  const observed=(await read()).github.project!;
  expect(observed.access.value?.defaultBranch).toBe('trunk');
  expect(observed.rules).toEqual({status:'forbidden',value:null,lastSuccessAt:null});
  expect(observed.protection).toEqual({status:'unavailable',value:null,lastSuccessAt:null});
});
test('PR reports enforce shared authority and repository access, with retained failures and account isolation',async()=>{
  const person=await fixture();
  const counts={status:'ok' as const,value:{open:4,drafts:2,merged:9,complete:true}};
  await publishGitHubAccess(person,connection,{...report(),pullRequests:counts},()=>at);
  expect((await read()).github.project?.pullRequests).toEqual({...counts,lastSuccessAt:at});
  await publishGitHubAccess(person,connection,{...report(at+1000),pullRequests:{status:'rate_limited',value:null}},()=>at+1000);
  expect((await read()).github.project?.pullRequests).toEqual({status:'rate_limited',value:counts.value,lastSuccessAt:at});
  // An installed beta.59 report does not refresh the prior PR receipt.
  await publishGitHubAccess(person,connection,report(at+2000),()=>at+2000);
  expect((await read()).github.project?.pullRequests?.lastSuccessAt).toBe(at);
  for(const change of [{access:{status:'forbidden',value:null}}, {pullRequests:{status:'ok',value:{open:1,drafts:2,complete:true}}},
    {pullRequests:{status:'ok',value:{open:501,drafts:0,complete:false}}}, {pullRequests:{...counts,value:{...counts.value,title:'private'}}},
    ...[-1,501,1.5].map(merged=>({pullRequests:{...counts,value:{...counts.value,merged}}}))])
    await expect(publishGitHubAccess(person,connection,{...report(at+3000),pullRequests:counts,...change},()=>at+3000)).rejects.toThrow();
  await publishGitHubAccess(person,connection,{...report(at+4000),account:{status:'ok',value:{login:'other-login'}},pullRequests:{status:'forbidden',value:null}},()=>at+4000);
  expect((await read()).github.project?.pullRequests?.value).toBeNull();
});
