// The dark current-state endpoint against the LIVE CS2a writers (c4 A1/E1 on integration): once startRun writes the agent
// group and runEndedAt, the status document is "complete" and the endpoint derives the row from it alone. Each case
// compares the endpoint's row with today's authoritative read (communicationAgents) at the same moment.
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { inProject } from '../src/firestore.js';
import { webAgentStarts } from '../src/owner/web-agent-starts.js';
import { presence } from '../src/v2/records.js';
import { startRun } from '../src/v2/runs.js';
import { communicationAgents } from '../src/view/communication-agents.js';
import { readCurrentState, stopCurrentState } from '../src/view/current-state.js';
import { resetEmulator, seed, seedRuntime, TEST_PROJECT } from './helpers.js';

const T = 2_000_000_000_000;
const scope = <V>(work: () => Promise<V>) => inProject(TEST_PROJECT, work);
beforeEach(async () => { stopCurrentState(); await resetEmulator(); });
afterEach(() => { stopCurrentState(); });

async function fixture() {
  const f = await seed({ profiles: [{ name: 'Alice', email: 'writers-alice@example.test' }], agents: [{ person: 0, name: 'alice-fox' }] });
  await seedRuntime(TEST_PROJECT, { started: true, paused: false });
  const fox = f.agents[0]!.agentId, alice = f.personIds[0]!;
  await scope(() => startRun(fox, { clientRunId: randomUUID(), runnerVersion: 'synthetic-no-model', takeover: false }, () => T));
  const doc = (await scope(() => presence().doc(fox).get())).data() as Record<string, unknown>;
  return { fox, alice, doc };
}
const endpointRow = async (viewer: string, id: string, now: number) => {
  for (let i = 0; i < 100; i++) {  // the listener's first snapshot
    const row = (await scope(() => readCurrentState(viewer, false, undefined, now))).rows.find(r => r.id === id);
    if (row && 'state' in row) return row;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('No row.');
};
const authoritative = async (viewer: string, id: string, now: number) =>
  (await scope(() => communicationAgents({ ids: id }, viewer, now))).agents[0]!;

test('control: a live run started by the real writer is complete and the endpoint matches the authoritative state', async () => {
  const { fox, alice, doc } = await fixture();
  expect(doc.agent).toBeDefined();
  expect('runEndedAt' in doc).toBe(true);  // complete: derived from the document alone
  const at = T + 1_000;
  expect((await endpointRow(alice, fox, at)).state).toBe((await authoritative(alice, fox, at)).state);
});

test('an agent with a pending web start shows Waiting today; the endpoint must agree although no writer sets the start group yet', async () => {
  const { fox, alice } = await fixture();
  // A pending restart of this existing agent from the website (the fields today's query reads; c4's start writers
  // will mirror it into the status document's start group).
  await webAgentStarts.doc(`writers-${fox}`).set({ profileId: alice, projectId: TEST_PROJECT, agentId: fox, state: 'pending',
    name: 'alice-fox', createdAt: T, pickupByAt: T + 600_000, activeUntil: T + 600_000 } as never);
  const at = T + 1_000;
  const truth = await authoritative(alice, fox, at);
  expect(truth.state).toBe('waiting');
  expect((await endpointRow(alice, fox, at)).state).toBe(truth.state);
});
