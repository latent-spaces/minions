import { randomUUID } from 'node:crypto';
// OPE-43 item 7: a retry after a lost response is answered only at current authority. A replay never outlives a removed
// membership or a revoked agent, and the same retry in a second project is judged on that project's own authority.
import { beforeEach, expect, test } from 'vitest';
import { inProject, profiles, type Agent, type WithId } from '../src/firestore.js';
import { configureWorkspace, controlWorkspace } from '../src/projects/store.js';
import { revokeOwned } from '../src/onboarding/store.js';
import { sendMessageV2 } from '../src/v2/messages.js';
import { inboxItems } from '../src/v2/records.js';
import { startRun } from '../src/v2/runs.js';
import { addAgent, loadAgent, resetEmulator, seed, seedApprovedProject, setTestMembership } from './helpers.js';

const A = 'a'.repeat(64), B = 'b'.repeat(64), now = () => 1000;
const config = (id: string, revision = 0) => ({ client_request_id: id, expected_revision: revision, repoUrl: 'https://github.com/example/library' });
beforeEach(resetEmulator);

type Side = { project: string; agent: WithId<Agent>; runId: string; peer: string };
// Two started projects with the same owner and member. In each, the member's agent has a current run and the owner's agent is its recipient.
async function fixture() {
  // The member is an admin of the test workspace, which grants nothing in a new project.
  const s = await seed({ profiles: [{ name: 'Owner', email: 'owner@example.com' }, { name: 'Member', email: 'member@example.com' }] });
  const [owner, member] = await Promise.all(s.personIds.map(async id => ({ id, ...(await profiles.doc(id).get()).data()! })));
  const sides: Side[] = [];
  for (const project of [A, B]) {
    await seedApprovedProject(project, {definition: { title: 'Library', goal: 'Work together', beneficiaries: 'Neighbors', output: 'A useful project', scope: 'One result', acceptanceCriteria: 'Reviewed', sources: null, resources: null, mergeApproval: 'humans' }, ownerProfileId: owner.id, reviewerProfileId: owner.id, submittedRevision: 2, approvedAt: 1, required: false});
    await configureWorkspace(owner, project, config('setup'), now);
    await controlWorkspace(owner, project, { client_request_id: 'start', expected_revision: 1, action: 'start' }, now);
    await setTestMembership(project, member.id);
    sides.push(await inProject(project, async () => {
      const peer = await addAgent(owner.id, 'peer', now), worker = await addAgent(member.id, 'worker', now);
      const run = await startRun(worker.agentId, { clientRunId: randomUUID(), runnerVersion: 'test', takeover: false }, now);
      return { project, agent: await loadAgent(worker.agentId), runId: run.run_id, peer: peer.agentId };
    }));
  }
  return { owner, member, a: sides[0], b: sides[1] };
}
const send = (s: Side) => inProject(s.project, () => sendMessageV2(s.agent, { to: [s.peer], body: 'Hello', clientId: 'lost' }, now, s.runId));
const inboxSize = (s: Side) => inProject(s.project, async () => (await inboxItems(s.peer).get()).size);
const removeFromA = (member: { id: string }) => setTestMembership(A, member.id, 'removed');

test('a message retried after the sender\'s membership was removed is refused there and still replays in the other project', async () => {
  const { member, a, b } = await fixture();
  const [inA, inB] = [await send(a), await send(b)];
  expect([inA.duplicate, inB.duplicate]).toEqual([false, false]);
  await removeFromA(member);
  await expect(send(a)).rejects.toMatchObject({ code: 'unauthorized' });
  // The removed membership alone refuses the agent,
  await expect(send(a)).rejects.toMatchObject({ code: 'unauthorized', message: expect.stringContaining('no longer a member of this project') });
  // and after a rejoin the membership is active again, so only its new epoch refuses the connection from before.
  await setTestMembership(A, member.id);
  await expect(send(a)).rejects.toMatchObject({ code: 'unauthorized', message: expect.stringContaining('no longer a member of this project') });
  expect(await inboxSize(a)).toBe(1);
  expect(await send(b)).toEqual({ message: inB.message, duplicate: true });
  expect(await inboxSize(b)).toBe(1);
});

test('a message retried after the owner revoked the agent is refused there and still replays for the same person\'s agent in the other project', async () => {
  const { member, a, b } = await fixture();
  const inB = await send(b);
  await send(a);
  await inProject(A, () => revokeOwned(member.id, a.agent.id, now));
  // Revoking also ends the run; the code and message show the revocation itself answers.
  await expect(send(a)).rejects.toMatchObject({ code: 'unauthorized', message: expect.stringContaining('no longer active') });
  expect(await inboxSize(a)).toBe(1);
  expect(await send(b)).toEqual({ message: inB.message, duplicate: true });
  expect(await inboxSize(b)).toBe(1);
});
