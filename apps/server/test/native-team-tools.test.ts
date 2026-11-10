import { randomUUID } from 'node:crypto';
// Native task tools through the real agent MCP endpoint: the catalog no longer offers GitHub Issue
// task tools, tasks start in Backlog, only agents are assigned, a claim has one winner and replays,
// stale writes are refused, and a linked pull request never completes a task.
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { FieldValue } from 'firebase-admin/firestore';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { v2Routes } from '../src/v2/routes.js';
import { db, inProject, agents as agentRecords } from '../src/firestore.js';
import { nativeTeams, nativeTeamMembers } from '../src/projects/native-teams.js';
import { saveNativeTeamSettings, readNativeTeamSettings } from '../src/projects/native-team-settings.js';
import { membershipDoc } from '../src/projects/access.js';
import { seedRuntime } from './helpers.js';
import { projects } from '../src/projects/records.js';
import { TEST_PROJECT, resetEmulator, scoped, seed } from './helpers.js';

const T = 2_000_000_000_000;
let server: Server;
let base: string;
let clients: Client[] = [];

beforeEach(async () => {
  await resetEmulator();
  const app = createMcpExpressApp();
  app.use('/v2', scoped(v2Routes(() => T)));
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v2`;
});

afterEach(async () => {
  await Promise.all(clients.map((client) => client.close()));
  clients = [];
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

async function connect(token: string) {
  const res = await fetch(`${base}/runs`, { method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ client_run_id: randomUUID(), runner_version: 'test-1' }) });
  const runId = (await res.json()).run_id as string;
  const client = new Client({ name: 'test-agent', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}`, 'X-Pilot-Run': runId } } }));
  clients.push(client);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    let reply;
    try { reply = await client.callTool({ name, arguments: args }); } catch (error) { return { ok: false, text: String(error), value: null }; }
    const text = (reply.content as { text: string }[])[0].text;
    return { ok: !reply.isError, text, value: reply.isError ? null : JSON.parse(text) };
  };
  return { client, call };
}

async function team() {
  const seeded = await seed({ profiles: [{ name: 'Dana', email: 'dana@example.com', role: 'owner' }, { name: 'Noam', email: 'noam@example.com' }],
    agents: [{ person: 0, name: 'amber' }, { person: 1, name: 'basil' }] });
  await projects.doc(TEST_PROJECT).update({ nativeTeams: { enabled: true, revision: 1 } });
  const [amber, basil] = await Promise.all(seeded.agents.map(agent => connect(agent.token)));
  return { seeded, amber, basil };
}

const create = (who: Awaited<ReturnType<typeof connect>>, request = 'create') => who.call('manage_team', { operation: 'create', name: 'Beta launch', purpose: 'Coordinate release checks', client_request_id: request });
const change = (who: Awaited<ReturnType<typeof connect>>, operation: string, team: { id: string; revision: number }, request: string = randomUUID()) => who.call('manage_team', { operation, team_id: team.id, expected_revision: team.revision, client_request_id: request });

test('Teams default OFF; discovery and stale calls refuse writes while retaining reads', async () => {
  const { seeded, amber } = await team();
  const created = await create(amber); expect(created.ok).toBe(true);
  await inProject(TEST_PROJECT, () => saveNativeTeamSettings(seeded.personIds[0], { enabled: false, expectedRevision: 1, clientRequestId: randomUUID() }));
  expect((await amber.client.listTools()).tools.map(tool => tool.name)).toContain('read_teams');
  expect((await amber.client.listTools()).tools.map(tool => tool.name)).not.toContain('manage_team');
  expect((await create(amber, 'off')).ok).toBe(false);
  expect((await amber.call('read_teams', { team_id: created.value.team.id })).value.members).toHaveLength(1);
  expect((await amber.call('get_project')).value.teams).toMatchObject({ enabled: false, tools: ['read_teams'] });
  // Removing the optional setting is also OFF, not a legacy ON fallback.
  await projects.doc(TEST_PROJECT).update({ nativeTeams: FieldValue.delete() });
  expect(await inProject(TEST_PROJECT, () => readNativeTeamSettings(seeded.personIds[0]))).toEqual({ enabled: false, revision: 0 });
});

test('creation joins only the caller; any member, including a different person’s agent, archives and restores', async () => {
  const { seeded, amber, basil } = await team();
  let result = await create(amber); expect(result.ok).toBe(true);
  let detail = (await amber.call('read_teams', { team_id: result.value.team.id })).value;
  expect(detail.members.map((member: { agentId: string }) => member.agentId)).toEqual([seeded.agents[0].agentId]);
  expect(await change(basil, 'archive', result.value.team)).toMatchObject({ ok: false, text: expect.stringContaining('forbidden') });
  result = await change(basil, 'join', result.value.team); expect(result.ok).toBe(true);
  const roster = (await amber.call('read_teams', { team_id: result.value.team.id })).value.members;
  const beforeAgents = await inProject(TEST_PROJECT, async () => (await agentRecords().get()).docs.map(row => row.data()));
  const beforeProject = (await projects.doc(TEST_PROJECT).get()).data();
  const task = await amber.call('create_task', { title: 'Preserve this task', client_request_id: 'task' });
  result = await change(basil, 'archive', result.value.team); expect(result.ok).toBe(true);
  expect(result.value.team.archived).toBe(true);
  expect((await amber.call('read_teams')).value.teams).toHaveLength(0);
  expect((await amber.call('read_teams', { archived: true })).value.teams).toHaveLength(1);
  detail = (await amber.call('read_teams', { team_id: result.value.team.id })).value;
  expect(detail.members).toEqual(roster);
  result = await change(amber, 'restore', result.value.team); expect(result.ok).toBe(true);
  detail = (await amber.call('read_teams', { team_id: result.value.team.id })).value;
  expect(detail.members).toEqual(roster);
  expect(detail.activity.map((event: { action: string }) => event.action)).toEqual(['restore', 'archive', 'join', 'create']);
  expect((await amber.call('get_task', { task_id: task.value.task.id })).value.task).toEqual(task.value.task);
  expect((await projects.doc(TEST_PROJECT).get()).data()).toEqual(beforeProject);
  expect(await inProject(TEST_PROJECT, async () => (await agentRecords().get()).docs.map(row => row.data()))).toEqual(beforeAgents);
});

test('self membership rejects peer targeting and grants no permanent creator or project-admin privileges', async () => {
  const { seeded, amber, basil } = await team();
  let result = await create(amber);
  for (const operation of ['join', 'leave', 'remove', 'update']) {
    const targeted = await amber.call('manage_team', { operation, team_id: result.value.team.id, expected_revision: 1, agent_id: seeded.agents[1].agentId, client_request_id: randomUUID() });
    expect(targeted.ok).toBe(false);
  }
  result = await change(basil, 'join', result.value.team);
  result = await change(amber, 'leave', result.value.team);
  expect(result.ok).toBe(true);
  expect(await change(amber, 'archive', result.value.team)).toMatchObject({ ok: false, text: expect.stringContaining('forbidden') });
  result = await change(basil, 'archive', result.value.team); expect(result.ok).toBe(true);
  expect(await change(amber, 'restore', result.value.team)).toMatchObject({ ok: false, text: expect.stringContaining('forbidden') });
  expect((await change(amber, 'join', result.value.team)).ok).toBe(false);
  result = await change(basil, 'restore', result.value.team); expect(result.ok).toBe(true);
  expect((await change(amber, 'join', result.value.team)).ok).toBe(true);
});

test('concurrent changes have one winner; retries return historical receipts without replaying membership or archive changes', async () => {
  const { amber, basil } = await team();
  const original = await create(amber);
  const [join, archive] = await Promise.all([change(basil, 'join', original.value.team), change(amber, 'archive', original.value.team)]);
  expect([join.ok, archive.ok].filter(Boolean)).toHaveLength(1);
  let current = (await amber.call('read_teams', { team_id: original.value.team.id })).value.team;
  if (current.archived) current = (await change(amber, 'restore', current)).value.team;
  const retryCreate = await create(amber);
  expect(retryCreate.value).toMatchObject({ replayed: true, team: { revision: 1, memberCount: 1 } });
  expect((await amber.call('read_teams', { team_id: current.id })).value.team.revision).toBe(current.revision);
  const archived = await change(amber, 'archive', current, 'archive-retry');
  const restored = await change(amber, 'restore', archived.value.team);
  const retry = await change(amber, 'archive', current, 'archive-retry');
  expect(retry.value).toMatchObject({ replayed: true, team: { archived: true } });
  expect((await amber.call('read_teams', { team_id: current.id })).value.team).toEqual(restored.value.team);
  expect((await amber.call('manage_team', { operation: 'create', name: 'Different', client_request_id: 'create' })).ok).toBe(false);
  const detail = (await amber.call('read_teams', { team_id: current.id })).value;
  expect(new Set(detail.activity.map((event: { revision: number }) => event.revision)).size).toBe(detail.activity.length);
});

test('OFF preserves membership/history, refuses even receipt replays in the domain service, and ON restores access without execution changes', async () => {
  const { seeded, amber } = await team();
  const created = await create(amber);
  const snapshot = await inProject(TEST_PROJECT, async () => ({ team: (await nativeTeams().doc(created.value.team.id).get()).data(), members: (await nativeTeamMembers(created.value.team.id).get()).docs.map(row => row.data()) }));
  await inProject(TEST_PROJECT, () => saveNativeTeamSettings(seeded.personIds[0], { enabled: false, expectedRevision: 1, clientRequestId: randomUUID() }));
  // Call the domain directly to exercise the guard behind tool discovery.
  const { mutateNativeTeam } = await import('../src/projects/native-teams.js');
  const { startRun } = await import('../src/v2/runs.js');
  const run = await inProject(TEST_PROJECT, () => startRun(seeded.agents[0].agentId, { clientRunId: randomUUID(), runnerVersion: 'test', takeover: true }, () => T));
  const actor = await inProject(TEST_PROJECT, async () => ({ kind: 'agent' as const, agent: { id: seeded.agents[0].agentId, ...(await agentRecords().doc(seeded.agents[0].agentId).get()).data()! }, runId: run.run_id }));
  await expect(inProject(TEST_PROJECT, () => mutateNativeTeam(actor, { operation: 'create', name: 'Beta launch', purpose: 'Coordinate release checks', clientRequestId: 'create' }, () => T))).rejects.toMatchObject({ code: 'teams_disabled' });
  expect(await inProject(TEST_PROJECT, async () => ({ team: (await nativeTeams().doc(created.value.team.id).get()).data(), members: (await nativeTeamMembers(created.value.team.id).get()).docs.map(row => row.data()) }))).toEqual(snapshot);
  await inProject(TEST_PROJECT, () => saveNativeTeamSettings(seeded.personIds[0], { enabled: true, expectedRevision: 2, clientRequestId: randomUUID() }));
  expect(await inProject(TEST_PROJECT, () => mutateNativeTeam(actor, { operation: 'create', name: 'Beta launch', purpose: 'Coordinate release checks', clientRequestId: 'create' }, () => T))).toMatchObject({ replayed: true });
});

test('revocation, removed project membership, closure and another project never grant team mutation authority', async () => {
  const { seeded, amber, basil } = await team();
  const created = await create(amber);
  const other = 'a'.repeat(64);
  await inProject(other, () => nativeTeams().doc('foreign').set({ ...created.value.team, id: 'foreign', projectId: other }));
  expect((await amber.call('read_teams', { team_id: 'foreign' })).ok).toBe(false);
  expect((await change(amber, 'join', { id: 'foreign', revision: 1 })).ok).toBe(false);
  await membershipDoc(TEST_PROJECT, seeded.personIds[1]).update({ status: 'removed' });
  expect(await change(basil, 'join', created.value.team)).toMatchObject({ ok: false, text: expect.stringContaining('unauthorized') });
  await seedRuntime(TEST_PROJECT, { completedAt: T, paused: true });
  expect(await change(amber, 'archive', created.value.team)).toMatchObject({ ok: false, text: expect.stringContaining('forbidden') });
  await inProject(TEST_PROJECT, () => agentRecords().doc(seeded.agents[0].agentId).update({ revokedAt: T }));
  expect((await amber.call('read_teams')).ok).toBe(false);
});

test('read tools bound and page rosters/history, search literal names, and attribute authored text', async () => {
  const { seeded, amber, basil } = await team();
  let result = await create(amber);
  result = await change(basil, 'join', result.value.team);
  result = await change(basil, 'archive', result.value.team);
  result = await change(amber, 'restore', result.value.team);
  const first = (await amber.call('read_teams', { team_id: result.value.team.id, page_size: 1 })).value;
  expect(first.members).toHaveLength(1); expect(first.nextMemberCursor).toBeTruthy();
  expect(first.activity).toHaveLength(1); expect(first.activity[0].action).toBe('restore');
  const next = (await amber.call('read_teams', { team_id: result.value.team.id, member_cursor: first.nextMemberCursor, activity_cursor: first.nextActivityCursor, page_size: 1 })).value;
  expect(next.members[0].agentId).not.toBe(first.members[0].agentId); expect(next.activity[0].action).toBe('archive');
  expect(first.team.name).toMatchObject({ trust: 'untrusted', source: { agentId: seeded.agents[0].agentId }, content: 'Beta launch' });
  expect(first.activity[0].team.purpose.trust).toBe('untrusted');
  expect((await amber.call('read_teams', { search: 'BETA' })).value.teams).toHaveLength(1);
  expect((await amber.call('read_teams', { search: '[.*]' })).value.teams).toHaveLength(0);
  expect((await amber.call('read_teams', { team_id: '../foreign' })).ok).toBe(false);
});

test('every new team mutation advances bounded progress in its transaction; replays do not', async () => {
  const { amber, basil } = await team();
  const progress = () => db.collection(`projects/${TEST_PROJECT}/nativeTeamProgress`).get();
  const revision = async () => (await progress()).docs.reduce((sum, row) => sum + row.data().revision, 0);
  expect(await revision()).toBe(0);
  let result = await create(amber);
  expect(await revision()).toBe(1);
  expect((await create(amber)).value.replayed).toBe(true);
  expect(await revision()).toBe(1);
  result = await change(basil, 'join', result.value.team); expect(await revision()).toBe(2);
  result = await change(amber, 'archive', result.value.team); expect(await revision()).toBe(3);
  result = await change(basil, 'restore', result.value.team); expect(await revision()).toBe(4);
  await change(basil, 'leave', result.value.team); expect(await revision()).toBe(5);
  expect((await progress()).size).toBeLessThanOrEqual(16);
});

test('person exports keep their agents’ team membership/actions without copying another creator’s text', async () => {
  const { seeded, amber, basil } = await team();
  const mine = await create(basil, 'my-team');
  const theirs = await create(amber, 'their-team');
  await change(basil, 'join', theirs.value.team);
  const { exportPerson } = await import('../src/store/person-export.js');
  const exported = await exportPerson(seeded.personIds[1], () => T);
  const base = `projects/${TEST_PROJECT}/nativeTeams/`;
  expect(exported.records.some(row => row.path === `${base}${mine.value.team.id}`)).toBe(true);
  expect(exported.records.some(row => row.path === `${base}${theirs.value.team.id}`)).toBe(false);
  expect(exported.records.some(row => row.path === `${base}${theirs.value.team.id}/members/${seeded.agents[1].agentId}`)).toBe(true);
  const history = exported.records.filter(row => row.path.startsWith(`${base}${theirs.value.team.id}/activity/`));
  expect(history).toHaveLength(1);
  expect(history[0].data).toMatchObject({ action: 'join', team: expect.stringContaining('withheld') });
  const receipts = exported.records.filter(row => row.path.includes('/nativeTeamReceipts/'));
  expect(receipts).toHaveLength(2);
  expect(JSON.stringify(receipts)).not.toContain('Coordinate release checks');
});
