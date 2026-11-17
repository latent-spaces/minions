import { randomUUID } from 'node:crypto';
import { beforeEach, expect, test } from 'vitest';
import { inProject } from '../src/firestore.js';
import { presence } from '../src/v2/records.js';
import { startRun } from '../src/v2/runs.js';
import { sendMessageV2 } from '../src/v2/messages.js';
import { readCurrentState } from '../src/view/current-state.js';
import { deriveAgentState, TALKING_MS } from '../src/view/communication-agents.js';
import { sourcesFromStatusDoc, type AgentStatusDoc } from '../src/view/agent-status-doc.js';
import { loadAgent, resetEmulator, seed, TEST_PROJECT } from './helpers.js';

beforeEach(resetEmulator);

// The map reads the status document, not the agent record, so a send must reach it for the map to show Talking.
test('a sent message makes an idle agent Talking in the status document the map reads, until the window ends', async () => {
  await inProject(TEST_PROJECT, async () => {
    const { agents } = await seed({ profiles: [{ name: 'Owner', email: 'owner@example.test' }],
      agents: [{ name: 'amber', person: 0 }, { name: 'basil', person: 0 }] });
    const [a, b] = await Promise.all(agents.map(x => loadAgent(x.agentId)));
    let at = 1_000_000;
    await startRun(a.id, { clientRunId: randomUUID(), runnerVersion: 'test', takeover: false }, () => at);
    at += 6000;
    await sendMessageV2(a, { to: [b.id], body: 'hello', clientId: 'talking-1' }, () => at);

    const doc = (await presence().doc(a.id).get()).data() as unknown as AgentStatusDoc;
    expect(doc.agent?.lastSendAt).toBe(at);
    // The agent keeps in contact, so only the Talking window decides between Talking and Idle.
    const at2 = at + TALKING_MS + 1000;
    const idleAt = (now: number) => deriveAgentState(sourcesFromStatusDoc(a.id, { ...doc, phase: 'idle', lastContactAt: now },
      { allowed: () => true })!, now).state;
    expect(idleAt(at + 1000)).toBe('talking');
    expect(idleAt(at2)).toBe('idle');
  });
});

// The same path the map polls: the shared current-state projection must report the sender as Talking.
test('the map\'s current-state read reports a sender as talking right after a send', async () => {
  await inProject(TEST_PROJECT, async () => {
    const { personIds, agents } = await seed({ profiles: [{ name: 'Owner', email: 'owner@example.test', role: 'owner' }],
      agents: [{ name: 'amber', person: 0 }, { name: 'basil', person: 0 }] });
    const [a, b] = await Promise.all(agents.map(x => loadAgent(x.agentId)));
    const start = Date.now() - 20_000;
    await startRun(a.id, { clientRunId: randomUUID(), runnerVersion: 'test', takeover: false }, () => start);
    await sendMessageV2(a, { to: [b.id], body: 'hello', clientId: 'talking-2' }, () => start + 6000);
    let rows: Awaited<ReturnType<typeof readCurrentState>>['rows'] = [];
    for (let i = 0; i < 20 && !rows.some(row => row.id === a.id && !('removed' in row)); i++) {
      rows = (await readCurrentState(personIds[0], true, undefined, Date.now())).rows;
      if (!rows.some(row => row.id === a.id)) await new Promise(resolve => setTimeout(resolve, 100));
    }
    const row = rows.find(r => r.id === a.id);
    expect(row && 'state' in row ? row.state : row).toBe('talking');
  });
});
