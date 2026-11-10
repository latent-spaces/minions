// presence/{agent} is written by several writers. A run start resets only the run's own fields, merged, so a field
// group another writer keeps in the same document survives starts, takeovers, contacts and phase reports (the shared
// current-state record, c1/c2 contract). The run's own fields still start fresh on every run.
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, expect, test } from 'vitest';
import { V2_LIMITS } from '../src/config.js';
import { inProject } from '../src/firestore.js';
import { recordContact, reportPhase, startChatParticipation, startRun } from '../src/v2/runs.js';
import { presence } from '../src/v2/records.js';
import { resetEmulator, seed, TEST_PROJECT } from './helpers.js';

let clock = 2_000_000_000_000;
const now = () => clock;
const scope = <T>(fn: () => T) => inProject(TEST_PROJECT, fn);
beforeEach(async () => { await resetEmulator(); clock += 3_600_000; });

const STARTED_GROUP = expect.objectContaining({ revokedAt: null, focus: null, personaText: '' });
const RUN_FIELDS = ['runId', 'lastContactAt', 'phase', 'phaseAt', 'lastTurn', 'activity', 'acceptingWork', 'protocol', 'runEndedAt', 'runMode'];
// Stands in for a field group another writer (agent focus, worker summary) merges into the same document.
const OTHER = { statusAgent: { focus: 'Reviewing the contract', revision: 3 } };
// Another writer's group is not part of the Presence type yet; it is written through the raw document here.
const foreign = (id: string) => scope(() => presence().doc(id).set(OTHER as never, { merge: true }));
const stored = async (id: string) => (await scope(() => presence().doc(id).get())).data() ?? {};

async function agent() {
  const f = await seed({ profiles: [{ name: 'Presence person', email: 'presence@example.test' }], agents: [{ person: 0, name: 'Presence worker' }] });
  return f.agents[0].agentId;
}
const start = (id: string, takeover = false) =>
  scope(() => startRun(id, { clientRunId: randomUUID(), runnerVersion: 'synthetic-no-model', takeover }, now));

test('another writer\'s field group survives a run start, a takeover, a contact and a phase report', async () => {
  const id = await agent();
  const first = await start(id);
  await foreign(id);
  clock += V2_LIMITS.contactWriteSeconds * 1000;
  expect(await scope(() => recordContact(id, first.run_id, clock))).toBe(clock);
  await scope(() => reportPhase(id, first.run_id, { phase: 'turn', activity: { tool: 'read_agent_inbox', at: clock } }, now));
  expect(await stored(id)).toMatchObject({ ...OTHER, runId: first.run_id, phase: 'turn', activity: { tool: 'read_agent_inbox', at: clock } });
  clock += 1_000;
  const second = await start(id, true);
  expect(await stored(id)).toMatchObject({ ...OTHER, runId: second.run_id, phase: 'idle' });
});

test('every run-owned field starts fresh on a new run; nothing from the previous run carries over', async () => {
  const id = await agent();
  const first = await start(id);
  await scope(() => reportPhase(id, first.run_id, { phase: 'turn', activity: { tool: 'old_tool', at: clock }, acceptingWork: false }, now));
  await scope(() => reportPhase(id, first.run_id, { phase: 'stopping', reason: 'operator' }, now));
  clock += 1_000;
  const second = await start(id);
  const doc = await stored(id);
  expect(doc).toEqual({ runId: second.run_id, lastContactAt: clock, phase: 'idle', phaseAt: clock, lastTurn: null, activity: null,
    acceptingWork: null, protocol: 2, runEndedAt: null, runMode: null, agent: STARTED_GROUP });
  // The run fields, plus the agent group every start also writes (from the agent it checked).
  expect(Object.keys(doc).sort()).toEqual([...RUN_FIELDS, 'agent'].sort());
});

test('a chat participation start also keeps another writer\'s group and resets the run fields', async () => {
  const id = await agent();
  const first = await start(id);
  await scope(() => reportPhase(id, first.run_id, { phase: 'turn', activity: { tool: 'old_tool', at: clock } }, now));
  await scope(() => reportPhase(id, first.run_id, { phase: 'stopping', reason: 'operator' }, now));
  await foreign(id);
  clock += 1_000;
  const chat = await scope(() => startChatParticipation(id, { clientRunId: randomUUID(), runnerVersion: 'synthetic-chat', approvedAt: clock,
    deadlineAt: clock + 600_000 }, now));
  expect(await stored(id)).toEqual({ ...OTHER, runId: chat.run_id, lastContactAt: clock, phase: 'idle', phaseAt: clock, lastTurn: null,
    activity: null, acceptingWork: null, protocol: 2, runEndedAt: null, runMode: 'current_chat', agent: STARTED_GROUP });
});

test('a phase report replaces the run group\'s map fields whole: a later lastTurn without usage keeps no old usage', async () => {
  const id = await agent();
  const run = await start(id);
  const usage = { sequence: 1, model: 'synthetic', seconds: 1, tokens: { input: 1, output: 1, modelCalls: 1, cacheRead: 0, cacheWrite: 0 } };
  await scope(() => reportPhase(id, run.run_id, { phase: 'idle', lastTurn: { kind: 'work', outcome: 'succeeded', endedAt: clock, usage } }, now));
  expect((await stored(id) as { lastTurn?: unknown }).lastTurn).toMatchObject({ usage });
  clock += 1_000;
  const bare = { kind: 'work', outcome: 'failed' as const, endedAt: clock };
  await scope(() => reportPhase(id, run.run_id, { phase: 'idle', lastTurn: bare }, now));
  expect((await stored(id) as { lastTurn?: unknown }).lastTurn).toEqual(bare);
});

// Source guard (c1): every write to presence/{agent} keeps other writers' field groups. Writes are either a merge of
// the writer's own group on presence().doc(...), or a partial update of phase/phaseAt through a reference read in the
// same transaction (the revocation paths). Every file that names the presence collection, by accessor or by a literal
// path, is pinned with its exact count, so a new reference fails until it is reviewed against the contract. Model-free.
const SRC = join(import.meta.dirname, '../src');
const files = (dir: string): string[] => readdirSync(dir).flatMap(name => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : [];
});
// File → references to the collection (presence() or a literal "presence" path segment), as reviewed at integration.
const REFERENCES: Record<string, number> = {
  'v2/records.ts': 1, 'v2/runs.ts': 15, 'v2/agent-group.ts': 1,
  'owner/agents.ts': 2, 'owner/computer-revocation.ts': 1,
  'onboarding/store.ts': 3, 'onboarding/registration.ts': 2,
  'projects/agent-focus.ts': 2, 'projects/agent-participation.ts': 2,
  'projects/member-cleanup.ts': 1, 'projects/worker-sessions.ts': 3,
  'projects/chat-controls.ts': 3, 'projects/close-work.ts': 3,
  'store/person-export.ts': 1, 'platform/diagnostics.ts': 1,
  'projects/worker-observations.ts': 1,
  // Member/public contact reads are centralized behind admission in this helper.
  'view/communication-agents.ts': 1,
  'view/current-state-progress-reader.ts': 2,
};
const REFERENCE = /presence\(\)|['"`/]presence['"`/]/g;
test('every presence write keeps other field groups, and every reference to the collection is pinned', () => {
  const found: Record<string, number> = {}, merges: string[] = [], groupWriters: string[] = [], groupStarts: string[] = [];
  for (const file of files(SRC)) {
    const text = readFileSync(file, 'utf8'), rel = file.slice(SRC.length + 1);
    const count = [...text.matchAll(REFERENCE)].length;
    if (count) found[rel] = count;
    expect(text, rel).not.toMatch(/=\s*presence\(\)\.doc\(/);
    expect(text, rel).not.toMatch(/presence\(\)\.doc\([^)]*\)\.(set|update|create|delete)\(/);
    for (const match of text.matchAll(/\.(set|update|create|delete)\(\s*presence\(\)\.doc\(/g)) {
      const statement = text.slice(match.index!, text.indexOf(';', match.index!));
      merges.push(rel);
      expect(match[1], `${rel}: ${statement.slice(0, 80)}`).toBe('set');
      expect(statement, `${rel}: presence write without merge`).toMatch(/\{\s*(merge:\s*true|mergeFields:\s*[^}]+)\s*\}\s*\)$/);
    }
    const starts = [...text.matchAll(/const started = \{ \.\.\.runPresence\([^)]*\), agent: agentGroup\(agent\) \};\n\s*statusProgress\(presence\(\)\.doc\(agentId\)\);\n\s*tx\.set\(presence\(\)\.doc\(agentId\), started, \{ mergeFields: Object\.keys\(started\) \}\);/g)].length;
    groupStarts.push(...Array<string>(starts).fill(rel));
    if (!rel.endsWith('v2/agent-group.ts')) {
      // These pure/read-only mappings build the group without writing presence. Keep their exact calls pinned.
      const readOnlyGroups = ['view/communication-agents.ts'].includes(rel) ? 1 : 0;
      expect([...text.matchAll(/agentGroup\(/g)].length, rel).toBe(starts + readOnlyGroups);
    }
    for (const match of text.matchAll(/(?:writeAgentGroup|writeCreatedAgentStatus)\(tx, ([^,]+),/g)) {
      groupWriters.push(rel);
      expect(match[1], rel).toMatch(/^(presence\(\)\.doc\((agentId|ref\.id|created\.id)\)|contactRef|record\.contact\.ref)$/);
    }
    // No write goes through a reference read earlier (revocations write via writeAgentGroup, which merges its groups).
    expect(text, rel).not.toMatch(/\.(set|update|create|delete)\(\s*(contactRef|(record\.)?contact\.ref)\b/);
  }
  expect(found).toEqual(REFERENCES);
  expect(merges.sort()).toEqual(['projects/chat-controls.ts', 'projects/close-work.ts', 'projects/worker-sessions.ts',
    'v2/runs.ts', 'v2/runs.ts', 'v2/runs.ts', 'v2/runs.ts']);
  // The agent group (A1) is written only by its helper, whole (mergeFields ['agent']), to the agent's presence document.
  const helper = readFileSync(join(SRC, 'v2/agent-group.ts'), 'utf8');
  // Two writes: the group (every agent-group writer) and creation's group plus the never-ran run group (card v20).
  expect([...helper.matchAll(/\.(set|update|create|delete)\(/g)].length).toBe(2);
  expect(helper).toContain("tx.set(status, { agent: agentGroup(after), ...run }, { mergeFields: ['agent', ...Object.keys(run)] });");
  expect(helper).toContain("tx.set(status, { agent: agentGroup(agent), runId: null, runEndedAt: null }, { mergeFields: ['agent', 'runId', 'runEndedAt'] });");
  // Besides the helper, only the two run starts write the group, whole (mergeFields), in their one presence write.
  expect(groupStarts).toEqual(['v2/runs.ts', 'v2/runs.ts']);
  expect(groupWriters.sort()).toEqual(['onboarding/registration.ts', 'onboarding/store.ts', 'owner/agents.ts',
    'owner/computer-revocation.ts', 'projects/agent-focus.ts', 'projects/agent-participation.ts', 'projects/member-cleanup.ts',
    'store/account-cleanup.ts']);
});
