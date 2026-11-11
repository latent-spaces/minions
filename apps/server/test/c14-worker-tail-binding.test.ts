// c14 probe, in the default suite since W1 and c5's reader landed. codex-1's worker-contact tail (89399326) bound to the ACTUAL worker-group
// writer (c4's W1, 77998645: syncWorkerSession merges presence.worker) and the ACTUAL status-document reader (c5's
// sourcesFromStatusDoc). It failed on the pre-12f1ca7f reader (worker.contactAt) and passes since.
// The fixture merges the agent and run-end groups directly (their writers are bound in c14-current-state-writers.test.ts);
// the worker group and every contact come from the actual writers.
import { randomUUID } from 'node:crypto';
import { beforeEach, expect, test } from 'vitest';
import { agents, db, inProject, type Agent } from '../src/firestore.js';
import { activeRecipientOperators, connectionAllowed } from '../src/projects/access.js';
import { syncWorkerSession, workerAvailable, workerSessions } from '../src/projects/worker-sessions.js';
import { presence } from '../src/v2/records.js';
import { startRun } from '../src/v2/runs.js';
import { sourcesFromStatusDoc, type AgentStatusDoc } from '../src/view/agent-status-doc.js';
import { canonicalStatusSources, deriveAgentState } from '../src/view/communication-agents.js';
import { resetEmulator, seed, TEST_PROJECT } from './helpers.js';

const T = 2_000_000_000_000;
const scope = <R>(work: () => Promise<R>) => inProject(TEST_PROJECT, work);
beforeEach(resetEmulator);

test('after the last worker sync, the status document keeps the worker live as long as the sources do (codex-1 tail)', async () => scope(async () => {
  let at = T;
  const now = () => at;
  const f = await seed({ profiles: [{ name: 'Synthetic owner', email: 'c14-tail@example.test' }], agents: [{ person: 0, name: 'Synthetic worker' }] });
  const id = f.agents[0]!.agentId, owner = f.personIds[0]!;
  const run = await startRun(id, { clientRunId: randomUUID(), runnerVersion: 'synthetic-no-model', takeover: false }, now);
  await presence().doc(id).set({ runEndedAt: null, runMode: null,
    agent: { name: 'Synthetic worker', ownerProfileId: owner, revokedAt: null, connectionEpoch: 0, focus: null, personaText: '' } } as never, { merge: true });
  const input = { run_id: run.run_id, missionId: randomUUID(), generation: 1, startedAt: T, deadlineAt: T + 600_000, remainingSlots: 0, phase: 'working' as const };
  for (const seconds of [20, 40, 60, 80]) { at = T + seconds * 1000; await syncWorkerSession(id, input, now); }
  at = T + 155_000;  // disconnected right after the t80 sync: the session says live until t170
  const session = (await workerSessions(id).doc(input.missionId).get()).data()!;
  const found = await agents().doc(id).get();
  const [sources] = await canonicalStatusSources([found], null);
  const doc = (await presence().doc(id).get()).data() as AgentStatusDoc;
  const operators = await db.runTransaction(tx => activeRecipientOperators(tx, [owner]), { readOnly: true });
  const fromDoc = sourcesFromStatusDoc(id, doc, { allowed: a => connectionAllowed(a as Agent, operators) });
  const actual = deriveAgentState(sources!, at), projected = fromDoc && deriveAgentState(fromDoc, at);
  console.info(JSON.stringify({ c14WorkerTail: { readSeconds: 155, sessionContactSeconds: (session.lastContactAt - T) / 1000,
    presenceContactSeconds: (doc.lastContactAt - T) / 1000, workerGroup: doc.worker, actual: actual.state, fromDoc: projected?.state } }));
  // W1 writes both copies in one transaction, so the sources (pointer summary, c5's default reader) and the document agree (c5).
  expect(doc.worker).toEqual({ runId: session.runId, phase: session.phase, lastContactAt: session.lastContactAt, deadlineAt: session.deadlineAt });
  expect(workerAvailable(session, at)).toBe(true);
  expect(actual.state).toBe('working');
  expect(fromDoc, 'the status document is complete').not.toBeNull();
  // The writer's group must carry the reader's contact field, or the reader falls back to the throttled presence contact.
  expect(projected, 'state from the status document equals state from the sources').toEqual(actual);
}), 60_000);
