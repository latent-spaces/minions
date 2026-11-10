// Current-state contract C3, the status document's agent group, rollout stage A1: every writer of an agent field the
// group carries (creation, revocation, focus, persona) writes presence/{agent}.agent whole, equal to the committed agent
// document, in the same transaction. Readers are unchanged (the agent document stays the authority).
import express from 'express';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { agents, inProject } from '../src/firestore.js';
import { registerAgentTeam } from '../src/onboarding/registration.js';
import { revokeOwned } from '../src/onboarding/store.js';
import { connectOwnAgent } from '../src/owner/agents.js';
import { reportAgentFocus } from '../src/projects/agent-focus.js';
import { saveAgentPersona } from '../src/projects/agent-participation.js';
import { agentGroup } from '../src/v2/agent-group.js';
import { presence } from '../src/v2/records.js';
import { startRun } from '../src/v2/runs.js';
import { viewRoutes } from '../src/view/routes.js';
import { hashToken, newToken } from '../src/auth.js';
import { idTokenFor, resetEmulator, scoped, seed, TEST_PROJECT } from './helpers.js';

let at = 20_000_000, server: Server, base: string;
const now = () => at;
const scope = <T>(work: () => T) => inProject(TEST_PROJECT, work);
beforeAll(async () => {
  const app = express();
  app.use('/view', scoped(viewRoutes(now)));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
beforeEach(async () => { await resetEmulator(); at += 100_000; });

const status = (id: string) => scope(() => presence().doc(id).get());
const agentDoc = async (id: string) => (await scope(() => agents().doc(id).get())).data()!;
// The group equals the committed agent document's.
const expectGroupMatches = async (id: string) => expect((await status(id)).data()?.agent).toEqual(agentGroup(await agentDoc(id)));
async function person() {
  const f = await seed({ profiles: [{ name: 'Group owner', email: 'group-owner@example.test' }] });
  return f.personIds[0];
}
async function running(owner: string, name = 'group-agent') {
  const [{ agentId }] = (await scope(() => registerAgentTeam(owner, [name], randomUUID(), now))).agents;
  const run = await scope(() => startRun(agentId, { clientRunId: randomUUID(), runnerVersion: 'synthetic-no-model', takeover: false }, now));
  return { agentId, runId: run.run_id };
}
const focus = (agentId: string, runId: string, text: string, sequence?: number, requestId = randomUUID()) =>
  scope(() => reportAgentFocus(agentId, runId, { status: text, client_request_id: requestId }, now, sequence));

test('creation writes the whole group, and an agent that never ran still shows no contact', async () => {
  const owner = await person();
  const { agents: made } = await scope(() => registerAgentTeam(owner, ['first', 'second'], randomUUID(), now));
  for (const { agentId } of made) {
    await expectGroupMatches(agentId);
    expect((await status(agentId)).data()).toEqual({ runId: null, runEndedAt: null, agent: { name: (await agentDoc(agentId)).name, ownerProfileId: owner,
      revokedAt: null, connectionEpoch: (await agentDoc(agentId)).connectionEpoch, focus: null, personaText: '' } });
  }
  const connected = await scope(() => connectOwnAgent(owner, { name: 'connected', candidateTokenHash: hashToken(newToken()),
    clientName: 'test', folder: '/tmp/synthetic-agent' }, now));
  await expectGroupMatches(connected.agentId);
  // The explicit no-run creation marker is not a contact (the reader checks the run group, not existence).
  const token = await idTokenFor('group-owner@example.test');
  const row = await fetch(`${base}/view/agents/${made[0].agentId}`, { headers: { authorization: `Bearer ${token}` } }).then(r => r.json());
  expect(row.agent.v2Contact).toBeNull();
});

test('focus writes the group with the new focus; a superseded or replayed report writes nothing', async () => {
  const owner = await person(), { agentId, runId } = await running(owner);
  const requestId = randomUUID();
  await focus(agentId, runId, 'Reading the writer inventory.', 2, requestId);
  await expectGroupMatches(agentId);
  expect((await status(agentId)).data()?.agent?.focus).toEqual({ text: 'Reading the writer inventory.', updatedAt: at });
  const written = (await status(agentId)).updateTime!;
  at += 1_000;
  expect((await focus(agentId, runId, 'Older observation.', 1)).superseded).toBe(true);
  expect((await focus(agentId, runId, 'Reading the writer inventory.', 2, requestId)).replayed).toBe(true);
  expect((await status(agentId)).updateTime!.isEqual(written)).toBe(true);
  // The run group beside it is untouched by the agent group's writes.
  expect((await status(agentId)).data()).toMatchObject({ runId, phase: 'idle' });
});

test('persona and revocation write the group; revocation still marks the run stopping', async () => {
  const owner = await person(), { agentId, runId } = await running(owner);
  await scope(() => saveAgentPersona(owner, agentId, { text: 'Careful reviewer.', expectedRevision: 0 }, now));
  await expectGroupMatches(agentId);
  expect((await status(agentId)).data()?.agent?.personaText).toBe('Careful reviewer.');
  at += 1_000;
  await scope(() => revokeOwned(owner, agentId, now));
  await expectGroupMatches(agentId);
  expect((await status(agentId)).data()).toMatchObject({ runId, phase: 'stopping', phaseAt: at, agent: { revokedAt: at, personaText: 'Careful reviewer.' } });
});

test('a revocation racing focus reports: the stored group is always the final agent document', async () => {
  const owner = await person();
  for (let i = 0; i < 4; i++) {
    const { agentId, runId } = await running(owner, `racer-${i}`);
    at += 1_000;
    await Promise.allSettled([
      focus(agentId, runId, `Step ${i} a.`), scope(() => revokeOwned(owner, agentId, now)), focus(agentId, runId, `Step ${i} b.`),
    ]);
    expect((await agentDoc(agentId)).revokedAt).toBe(at);
    await expectGroupMatches(agentId);
  }
}, 90_000);  // the emulator's transaction lock retries are slow

test('an agent created before A1 gets its whole group at its next run start, with no extra read', async () => {
  const f = await seed({ profiles: [{ name: 'Older owner', email: 'older-owner@example.test' }], agents: [{ person: 0, name: 'older' }] });
  const id = f.agents[0].agentId;  // seeded directly: no agent group, as for an agent created before A1
  await scope(() => presence().doc(id).delete()); // explicit historical fixture; no migration is run
  expect((await status(id)).exists).toBe(false);
  await scope(() => startRun(id, { clientRunId: randomUUID(), runnerVersion: 'synthetic-no-model', takeover: false }, now));
  await expectGroupMatches(id);
  expect((await status(id)).data()).toMatchObject({ runEndedAt: null, agent: { name: 'older', revokedAt: null } });
});
