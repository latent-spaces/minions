import { beforeEach, expect, test } from 'vitest';
import { db, profiles } from '../src/firestore.js';
import { exportPerson } from '../src/store/person-export.js';
import { idTokenFor, resetEmulator, seed, TEST_PROJECT } from './helpers.js';
beforeEach(resetEmulator);
async function fixture(){const f=await seed({profiles:[{name:'Reader',email:'reader@example.test'},{name:'Peer',email:'peer@example.test'}]});return {...f,person:{id:f.personIds[0],...(await profiles.doc(f.personIds[0]).get()).data()!},token:await idTokenFor('reader@example.test')};}
test('person export includes own approvals and updates without verifiers',async()=>{
 const f=await fixture();
 await db.doc('computerConnections/computer').set({profileId:f.person.id,candidateTokenHash:'secret-candidate',pollingSecretHash:'secret-poll',clientName:'Codex'});
 await db.doc(`projects/${TEST_PROJECT}/updates/update`).set({author:{profile:{id:f.person.id}},body:'Own update'});
 await db.doc(`projects/${TEST_PROJECT}/progressOperations/update`).set({update:{author:{profile:{id:f.person.id}},body:'Own update'}});
 const result=await exportPerson(f.person.id,()=>10000),serialized=JSON.stringify(result);
 expect(serialized).toContain('Own update');expect(serialized).not.toContain('secret-candidate');expect(serialized).not.toContain('secret-poll');
 expect(result.records.some(r=>r.path==='computerConnections/computer')).toBe(true);
});

test('person export withholds every other author’s human-request text and preserves own fields', async () => {
  const f = await fixture(), requester = f.person.id, answerer = f.personIds[1];
  const request = {
    requesterProfileId: requester, title: 'Requester title', question: 'Requester question', context: 'Requester context',
    attempted: 'Requester recovery', blockerTitle: 'Requester blocker', attemptedTitle: 'Requester attempt',
    suggestedOptions: ['Requester suggestion'], selectionMode: 'multiple',
    answer: { profileId: answerer, body: 'Answerer body', customAnswer: 'Answerer custom text', optionIndices: [0], at: 2000 },
    resolution: { body: 'Requester resolution', at: 3000 },
  };
  await db.doc('humanRequests/export-authorship').set(request);
  const row = async (person: string) => (await exportPerson(person, () => 10000)).records
    .find(record => record.path === 'humanRequests/export-authorship')!.data as typeof request;
  const ownRequest = await row(requester), ownAnswer = await row(answerer);
  expect(ownRequest).toMatchObject({ ...request, answer: { ...request.answer,
    body: '[withheld: written by someone else]', customAnswer: '[withheld: written by someone else]' } });
  expect(ownAnswer).toMatchObject({ answer: request.answer, selectionMode: 'multiple',
    title: '[withheld: written by someone else]', question: '[withheld: written by someone else]',
    context: '[withheld: written by someone else]', attempted: '[withheld: written by someone else]',
    blockerTitle: '[withheld: written by someone else]', attemptedTitle: '[withheld: written by someone else]',
    suggestedOptions: ['[withheld: written by someone else]'], resolution: { body: '[withheld: written by someone else]' } });
  expect(JSON.stringify(ownRequest)).not.toContain('Answerer');
  expect(JSON.stringify(ownAnswer)).not.toContain('Requester');
});

test('person export attributes moderation resolutions to the human reviewer', async () => {
  const f = await fixture(), requester = f.person.id, reviewer = f.personIds[1];
  await db.doc('humanRequests/moderation-export').set({
    requesterProfileId: requester, title: 'Reporter concern', question: 'Reporter question', context: 'Reporter context',
    visibility: 'moderators', moderation: { category: 'security' },
    answer: { profileId: reviewer, body: 'Reviewer outcome', at: 2000 },
    resolution: { body: 'Reviewer outcome', at: 2000 },
  });
  const requesterExport = await exportPerson(requester, () => 10000);
  const reviewerExport = await exportPerson(reviewer, () => 10000);
  const requesterRow = requesterExport.records.find(record => record.path === 'humanRequests/moderation-export')!;
  const reviewerRow = reviewerExport.records.find(record => record.path === 'humanRequests/moderation-export')!;
  expect(JSON.stringify(requesterRow)).not.toContain('Reviewer outcome');
  expect(reviewerRow.data).toMatchObject({
    answer: { body: 'Reviewer outcome' }, resolution: { body: 'Reviewer outcome' },
    title: '[withheld: written by someone else]', moderation: '[withheld: written by someone else]',
  });
});
