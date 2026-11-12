import { indexConversations } from '../scripts/index-conversations.js';
import { randomUUID } from 'node:crypto';
// Every Google-token project route refuses profiles outside the project (OPE-71). The route lists come from
// fresh router instances, so a route added or removed without updating this matrix fails the first test.
import express, { type Router } from 'express';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { hashToken } from '../src/auth.js';
import { agents, db, inProject, profiles } from '../src/firestore.js';
import { onboardingRoutes } from '../src/onboarding/routes.js';
import { projectManagementRoutes, projectRuntimeRoutes } from '../src/projects/routes.js';
import { configureWorkspace } from '../src/projects/store.js';
import { createFanout } from '../src/v2/fanout.js';
import { fanoutJobId, fanoutJobs } from '../src/v2/fanout-jobs.js';
import { messagesV2 } from '../src/v2/records.js';
import { conversationEntries } from '../src/projects/steering.js';
import { mutateNativeTask } from '../src/projects/native-tasks.js';
import { nativeTeams, nativeTeamMembers, nativeTeamActivity } from '../src/projects/native-teams.js';
import { viewRoutes } from '../src/view/routes.js';
import { stopCurrentState } from '../src/view/current-state.js';
import { identity } from '../src/identity/index.js';
import { addAgent, idTokenFor, resetEmulator, seed, seedApprovedProject, setTestMembership } from './helpers.js';

const A = 'a'.repeat(64), B = 'b'.repeat(64);
const clock = 1_000;
const now = () => clock;

// Routes as each router declares them. Writes carry a valid body, so a refusal comes from access and not
// from input checks. `reads` is the least role that gets 200 on a read; without it only the owner does.
// 'operator' is a read that only the probe agent's own operator (the member) gets, and the owner does not.
type Row = { reads?: 'member' | 'operator'; body?: object; query?: Record<string, string> };
const MANAGEMENT: Record<string, Row> = {
  'GET /:id': { reads: 'member' },
  'POST /:id/visit': { body: {} },
  'GET /:id/my-karma': { reads: 'member' },
  'GET /:id/native-task-settings': { reads: 'member' },
  'POST /:id/native-task-settings': { body: { enabled: false, expectedRevision: 0, clientRequestId: '21111111-1111-4111-8111-111111111111' } },
  'GET /:id/native-team-settings': { reads: 'member' },
  'POST /:id/native-team-settings': { body: { enabled: true, expectedRevision: 0, clientRequestId: '31111111-1111-4111-8111-111111111111' } },
  'GET /:id/teams': { reads: 'member' },
  'GET /:id/teams/:teamId': { reads: 'member' },
  'GET /:id/tasks': { reads: 'member' },
  'GET /:id/tasks/changes': { reads: 'member' },
  'GET /:id/tasks/:taskId': { reads: 'member' },
  'POST /:id/tasks': { body: { operation: 'create', title: 'Access probe', clientRequestId: '11111111-1111-4111-8111-111111111111' } },
  'POST /:id/personal-star': { body: { starred: true } },
  'POST /:id/personal-archive': { body: { client_request_id: 'probe', expected_revision: 0, archived: true } },
  'POST /:id/configure': { body: { client_request_id: 'probe', expected_revision: 1, repoUrl: 'https://github.com/example/library' } },
  'POST /:id/community-rules': { body: { client_request_id: 'probe', expected_version: 1, body: 'Respect one another.' } },
  'GET /:id/project-update-settings': {},
  'POST /:id/project-update-settings': { body: { clientRequestId: 'probe', expectedRevision: 0, everyMinutes: 15 } },
  'GET /:id/communication': {},
  'POST /:id/communication': { body: { expectedRevision: 0, defaults: { broadcastAllowed: true, sendsPerHour: 60, minimumGapSeconds: 5, broadcastsPerHour: 2 }, sharedBroadcastsPerHour: 6 } },
  'GET /:id/agents/:agentId/persona': { reads: 'member' },
  'GET /:id/my-workers': { reads: 'member' },
  'POST /:id/agents/:agentId/background-control': { body: { id: '11111111-1111-4111-8111-111111111111', kind: 'pause', missionId: '22222222-2222-4222-8222-222222222222', generation: 1, approved: true } },
  'POST /:id/agents/:agentId/participation': { body: { id: '11111111-1111-4111-8111-111111111111', kind: 'extend', participationId: '22222222-2222-4222-8222-222222222222', generation: 1, expectedDeadlineAt: 10000, minutes: 5, approved: true } },
  'GET /:id/agents/:agentId/environment': { reads: 'operator' },
  'POST /:id/agents/:agentId/persona': { body: { expectedRevision: 0, text: '' } },
  'GET /:id/agents/:agentId/communication': { reads: 'member' },
  'POST /:id/agents/:agentId/communication': { body: { expectedRevision: 0, fields: {} } },
  'POST /:id/finalize': { body: { client_request_id: 'probe', expected_revision: 1, minContributors: 2, startDeadline: '2099-01-01T00:00:00.000Z' } },
  // These fixtures are unlisted. Invited outsiders may self-join a published project, tested in project-join.
  'POST /:id/join': { body: { client_request_id: 'probe' } },
  'POST /:id/control': { body: { client_request_id: 'probe', expected_revision: 1, action: 'start' } },
  'POST /:id/card': { body: { client_request_id: 'probe', expected_version: 1, definition: { title: 'Probe', goal: 'Probe', beneficiaries: 'Probe', output: 'Probe', scope: 'Probe', acceptanceCriteria: 'Probe', sources: null, resources: null, mergeApproval: 'humans' } } },
  'GET /:id/card/versions': { reads: 'member' },
  'GET /:id/merging': {},
  'GET /:id/catalog': {},
  'POST /:id/catalog': { body: { client_request_id: 'probe', expected_revision: 0, listed: true, summary: 'Probe', category: 'games', tags: [] } },
  'GET /:id/delivery': {},
  'POST /:id/delivery/:jobId/retry': { body: { client_request_id: 'probe', expected_generation: 0, reason: 'Access matrix probe.' } },
  'POST /:id/leave': { body: { client_request_id: '01a11111-1111-4111-8111-111111111111' } },
  'GET /:id/merge-access': { reads: 'member' },
  'POST /:id/merge-access': { body: { client_request_id: 'probe', expected_revision: 0, mode: 'existing', selected_profile_ids: [] } },
};
const VIEW: Record<string, Row> = {
  'GET /usage': { reads: 'member' },
  'GET /communication': { reads: 'member' },
  'GET /communication/events': { reads: 'member' },
  'GET /communication/timeline': { reads: 'member' },
  'GET /communication/traffic': { reads: 'member' },
  'GET /communication/roster': { reads: 'member' },
  'GET /communication/agents': { reads: 'member', query: { ids: 'probe' } },
  'GET /communication/agents/current': { reads: 'member' },
  'GET /overview': { reads: 'member' }, 'GET /members': { reads: 'member' }, 'GET /agents': { reads: 'member' }, 'GET /agents/:id': { reads: 'member' },
  'GET /threads/:id': { reads: 'member' }, 'GET /conversations': { reads: 'member' },
  'GET /messages/:id': { reads: 'member' },
  'GET /threads/:id/search': { reads: 'member', query: { q: 'Seeded' } },
  'GET /conversations/search': { reads: 'member', query: { q: 'Seeded' } },
  'GET /agents/:id/responsibilities': { reads: 'operator' },
  'GET /usage/analytics': { reads: 'member', query: { from: '1970-01-01', to: '1970-01-01' } },
  'GET /usage/context-now': { reads: 'member' },
  'GET /usage/context-runs': { reads: 'member' },
  'GET /usage/context-turns': { reads: 'member', query: { agentId: 'probe', runId: '11111111-1111-4111-8111-111111111111' } },
};
const JOIN: Record<string, Row> = {
  'POST /agents/:id/revoke': {}, 'POST /agents/register': { body: { name: 'browser-probe' } },
};
// Declared routes left out of the matrix:
// - GET /api/projects and /mine: any invited person may read their own directory.
// - GET /starters, /explore and the nested public reader: public discovery/projections, tested in public-project.
// /p/:id/v2/* takes agent tokens, not Google ones; agentByToken refuses removed profiles and memberships
// (member-cleanup.test.ts), and one HTTP case below checks it.
const LEFT_OUT = { management: ['GET /', 'GET /shortcuts', 'GET /mine', 'POST /private', 'GET /starters', 'GET /explore',
  'GET /:id/public-conversion', 'POST /:id/public-conversion', // Private projects only; owner-only review and conversion covered by private-projects.test.ts.
  'nested router router', 'path middleware jsonParser'], join: [] as string[] };

// 'METHOD /path' for each route a router declares. A nested router would hide its routes, and middleware mounted
// at a path can answer requests itself, so both are named too. Middleware for every path is not a route.
const declared = (router: Router) => [...new Set(router.stack.flatMap(layer => layer.route
  ? (Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path]).flatMap((path: string) =>
    layer.route!.stack.map(handler => `${handler.method.toUpperCase()} ${path}`))
  : 'stack' in layer.handle ? [`nested router ${layer.name}`] : (layer as { slash?: boolean }).slash ? [] : [`path middleware ${layer.name}`]))];
const fill = (path: string, values: Record<string, string>) => path.replace(/:(\w+)/g, (_, name: string) => values[name]);

let server: Server, base: string;
beforeAll(async () => {
  // v2Routes parse no body themselves; the engine gets that from createMcpExpressApp.
  const app = express(); app.use('/api/projects', projectManagementRoutes(now)); app.use('/p/:projectId/v2', express.json()); app.use('/p/:projectId', projectRuntimeRoutes(now));
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  stopCurrentState();
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
});
beforeEach(resetEmulator);

async function call(method: string, path: string, token: string, body?: object) {
  const privateEndpoint = /\/(?:private|invitations)(?:\/|$)|\/(?:leave|personal-archive|personal-star|visit)$|\/(?:tasks|native-task-settings|native-team-settings)(?:\/|$)/.test(path);
  const email = privateEndpoint ? (await identity().verifySession(token))?.email ?? null : null;
  const person = email ? (await profiles.where('email', '==', email).limit(1).get()).docs[0] : null;
  const response = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(person ? { 'X-Mlswarm-Profile-Id': person.id } : {}) },
    ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}) });
  return { status: response.status, body: await response.json().catch(() => null) };
}
const approve = (id: string, title: string, ownerId: string) => seedApprovedProject(id, { definition: { title, goal: 'Work together', beneficiaries: 'Neighbors', output: 'A useful project', scope: 'One result', acceptanceCriteria: 'Reviewed', sources: null, resources: null, mergeApproval: 'humans' }, ownerProfileId: ownerId, reviewerProfileId: ownerId, submittedRevision: 2, approvedAt: 1, required: false });

// Two configured projects with one owner. A has an active member, a person later removed from the community,
// and a member whose membership was removed; B has a member of its own. A also holds an agent and a message
// (both with ID 'probe'), a native team and a blocked delivery job, so reads find real records.
async function fixture() {
  const { personIds: [ownerId, memberId, removedId, leftId, otherId] } = await seed({ project: { paused: true }, profiles: [
    { name: 'Owner', email: 'owner@example.com' }, { name: 'Member', email: 'member@example.com' },
    { name: 'Removed', email: 'removed@example.com' }, { name: 'Left', email: 'left@example.com' }, { name: 'Other', email: 'other@example.com' },
  ] });
  const owner = { id: ownerId, ...(await profiles.doc(ownerId).get()).data()! };
  for (const [id, title] of [[A, 'Library'], [B, 'Garden']]) {
    await approve(id, title, ownerId);
    await configureWorkspace(owner, id, { client_request_id: 'setup', expected_revision: 0, repoUrl: 'https://github.com/example/library' }, now);
  }
  for (const personId of [memberId, removedId, leftId]) await setTestMembership(A, personId);
  await setTestMembership(B, otherId);
  const agentToken = (personId: string) => inProject(A, async () => (await addAgent(personId, 'runner', now)).token);
  const memberAgentToken = await agentToken(memberId), leftAgentToken = await agentToken(leftId);
  // The agent stays unrevoked, so only the membership check can refuse its token.
  await setTestMembership(A, leftId, 'removed');
  await profiles.doc(removedId).update({ removedAt: 2 });
  const { jobId, taskId, teamId } = await inProject(A, async () => {
    await agents().doc('probe').set({ ownerProfileId: memberId, connectionEpoch: 0, name: 'Probe', tokenHash: hashToken('probe'), createdAt: 1, revokedAt: null , tokenIssuedAt: 1});
    await messagesV2().doc('probe').set({ id: 'probe', agentId: 'probe', agentName: 'Probe', threadId: 'probe', body: 'Seeded', audience: 'project', to: ['project'], createdAt: 1, protocol: 2 });
    await conversationEntries().doc('probe').set({ kind: 'agent_message', id: 'probe', agentId: 'probe', agentName: 'Probe', threadId: 'probe', body: 'Seeded', audience: 'project', to: ['project'], createdAt: 1, protocol: 2 });
    const { task } = await mutateNativeTask({ kind: 'person', person: owner }, { operation: 'create', title: 'Native access fixture', clientRequestId: randomUUID() }, now);
    // Teams stay OFF in this fixture: legitimate retained reads must still return real records.
    // Setup fixtures directly because paused projects do not admit new agent team actions.
    const team = { id: 'probe-team', projectId: A, name: 'Native access team', purpose: 'Access matrix fixture',
      createdByAgentId: 'probe', archived: false, memberCount: 1, revision: 1, createdAt: clock, updatedAt: clock };
    await nativeTeams().doc(team.id).set(team);
    await nativeTeamMembers(team.id).doc('probe').set({ agentId: 'probe', active: true, joinedAt: clock, leftAt: null });
    const eventId = `0000000000000001_${'0'.repeat(64)}`;
    await nativeTeamActivity(team.id).doc(eventId).set({ id: eventId, teamId: team.id, actorAgentId: 'probe', action: 'create', revision: 1, at: clock, team });
    const sourceId = await db.runTransaction(async tx => createFanout(tx, 'announcement', { body: 'Seeded' }, now()));
    const jobId = fanoutJobId(A, sourceId);
    await fanoutJobs.doc(jobId).update({ status: 'blocked', failure: 'delivery_error', consecutiveFailures: 8 });
    return { jobId, taskId: task.id, teamId: team.id };
  });
  await indexConversations(A);
  const emails = { owner: 'owner@example.com', member: 'member@example.com', uninvited: 'outsider@example.com',
    removedPerson: 'removed@example.com', removedMembership: 'left@example.com', otherProject: 'other@example.com' };
  const tokens = Object.fromEntries(await Promise.all(Object.entries(emails).map(async ([actor, email]) => [actor, await idTokenFor(email)])));
  return { owner, memberId, removedId, tokens: tokens as Record<keyof typeof emails, string>, jobId, taskId, teamId, leftId, memberAgentToken, leftAgentToken };
}

test('the matrix lists every route the Google-token project routers declare, and nothing else', () => {
  expect({
    management: declared(projectManagementRoutes(now)).sort(), view: declared(viewRoutes(now)).sort(), join: declared(onboardingRoutes(now)).sort(),
  }).toEqual({
    management: [...Object.keys(MANAGEMENT), ...LEFT_OUT.management].sort(), view: Object.keys(VIEW).sort(), join: [...Object.keys(JOIN), ...LEFT_OUT.join].sort(),
  });
});

test('outsiders, removed profiles, removed memberships and other-project members are refused on every route; owners and members still read', async () => {
  const s = await fixture();
  const routers: { mount: string; rows: Record<string, Row>; values: Record<string, string> }[] = [
    { mount: '/api/projects', rows: MANAGEMENT, values: { id: A, agentId: 'probe', jobId: s.jobId, operatorId: s.leftId, personId: s.memberId, taskId: s.taskId, teamId: s.teamId } },
    { mount: `/p/${A}/api/view`, rows: VIEW, values: { id: 'probe' } },
    { mount: `/p/${A}/api/join`, rows: JOIN, values: { id: 'probe' } },
  ];
  const problems: string[] = [];
  for (const actor of ['uninvited', 'removedPerson', 'removedMembership', 'otherProject', 'owner', 'member'] as const) {
    // Limiters are keyed per person and each actor is a different person, so one pass stays under the
    // per-person limits (60 management, 60 view and 30 join requests a minute) while the lists stay that short.
    for (const { mount, rows, values } of routers) for (const [route, row] of Object.entries(rows)) {
      const [method, path] = route.split(' ');
      // Owners and members only read; their writes are covered by each feature's own tests.
      if ((actor === 'owner' || actor === 'member') && method !== 'GET') continue;
      const query = row.query ? '?' + new URLSearchParams(row.query) : '';
      const reply = await call(method, mount + fill(path, values) + query, s.tokens[actor], row.body);
      const reads = method === 'GET' && (row.reads === 'operator' ? actor === 'member'
        : actor === 'owner' || (actor === 'member' && row.reads === 'member'));
      const refused = [401, 403, 404].includes(reply.status) && Object.keys(reply.body ?? {}).sort().join() === 'error,message';
      if (reads ? reply.status !== 200 : !refused) problems.push(`${actor} ${route}: ${reply.status} ${JSON.stringify(reply.body)}`);
      if (reads && reply.status === 200 && route === 'GET /messages/:id' && reply.body.message?.id !== 'probe') problems.push(`${actor} ${route}: expected the seeded message`);
      if (reads && reply.status === 200 && route === 'GET /:id/native-team-settings') expect(reply.body).toEqual({ enabled: false, revision: 0 });
      if (reads && reply.status === 200 && route === 'GET /:id/teams') expect(reply.body.teams).toEqual([expect.objectContaining({ id: s.teamId, name: 'Native access team' })]);
      if (reads && reply.status === 200 && route === 'GET /:id/teams/:teamId') {
        expect(reply.body.team).toMatchObject({ id: s.teamId, purpose: 'Access matrix fixture' });
        expect(reply.body.members).toEqual([expect.objectContaining({ agentId: 'probe', active: true })]);
        expect(reply.body.activity).toEqual([expect.objectContaining({ actorAgentId: 'probe', action: 'create' })]);
      }
      if (reads && reply.status === 200 && row.query?.q === 'Seeded' && !reply.body.messages?.some((message: { id: string }) => message.id === 'probe')) problems.push(`${actor} ${route}: expected the seeded search match`);
    }
  }
  expect(problems).toEqual([]);
  // The project list is not refused, but it never names A to someone outside it.
  for (const actor of ['removedMembership', 'otherProject'] as const) {
    const list = await call('GET', '/api/projects', s.tokens[actor]);
    expect(list.status).toBe(200);
    expect(list.body.projects.map((p: { id: string }) => p.id)).not.toContain(A);
  }
  // A removed membership's agent token is refused too; an active member's still works.
  expect((await call('POST', `/p/${A}/v2/runs`, s.memberAgentToken, { client_run_id: randomUUID(), runner_version: 'test' })).status).toBe(200);
  expect(await call('POST', `/p/${A}/v2/runs`, s.leftAgentToken, { client_run_id: randomUUID(), runner_version: 'test' })).toMatchObject({ status: 401, body: { error: 'unauthorized' } });
}, 60_000);

// Agent routes and the other project's routes meet the membership as it is now (OPE-43).
// Start a run, report a phase, wait, and make one MCP tool call. The run ID is a placeholder where no run could start:
// a phase for an unknown run of a current agent is 409, so a 401 here comes from the token check.
async function agentCalls(project: string, token: string) {
  const started = await call('POST', `/p/${project}/v2/runs`, token, { client_run_id: randomUUID(), runner_version: 'test-1' }), run = started.body?.run_id ?? 'unstarted';
  const mcp = await fetch(`${base}/p/${project}/v2/mcp`, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_project', arguments: {} } }),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-pilot-run': run } });
  const text = await mcp.text();
  return [started, await call('POST', `/p/${project}/v2/runs/${run}/phase`, token, { phase: 'idle' }), await call('POST', `/p/${project}/v2/wait`, token, { run_id: run }),
    { status: mcp.status, body: mcp.ok ? text : JSON.parse(text) }];
}
// The middleware's message: the token lookup itself refuses, before any route's own membership check.
const refusedEverywhere = Array(4).fill({ status: 401, body: { error: 'unauthorized', message: expect.stringContaining('valid agent token') } });


test('a removed membership\'s agent token is refused on every agent route of A while the same person\'s agent works in B', async () => {
  const s = await fixture();
  await setTestMembership(B, s.leftId);
  const leftInB = await inProject(B, async () => (await addAgent(s.leftId, 'runner', now)).token);
  expect(await agentCalls(A, s.leftAgentToken)).toMatchObject(refusedEverywhere);
  const inB = await agentCalls(B, leftInB);
  expect(inB.map(reply => reply.status)).toEqual([200, 200, 200, 200]);
  expect(inB[3].body).toContain('Garden');
}, 30_000);


test('label lookups by id answer only rows the directory pages would list, retired agents included', async () => {
  const s = await fixture();
  const view = (path: string, token = s.tokens.member) => call('GET', `/p/${A}/api/view${path}`, token);
  const { removedId } = s;
  await inProject(A, () => agents().doc('retired').set({ ownerProfileId: s.memberId, connectionEpoch: 0, name: 'Retired', tokenHash: hashToken('retired'), createdAt: 1, revokedAt: 5, tokenIssuedAt: 1 }));
  const found = await view('/agents?ids=probe,retired,missing');
  expect(found.status).toBe(200);
  expect(found.body.next).toBeNull();
  expect(found.body.agents.map((a: { id: string; name: string; revokedAt: number | null }) => [a.id, a.name, a.revokedAt]).sort()).toEqual([['probe', 'Probe', null], ['retired', 'Retired', 5]]);
  // The removed membership, the removed profile and a stranger are not on the roster pages, so they are not here.
  const people = await view(`/members?ids=${[s.owner.id, s.memberId, s.leftId, removedId, 'stranger'].join(',')}`);
  expect(people.status).toBe(200);
  expect(people.body.members.map((p: { id: string; owner: boolean }) => [p.id, p.owner]).sort()).toEqual([[s.memberId, false], [s.owner.id, true]].sort());
  const sixty = Array.from({ length: 60 }, (_, i) => `id${i}`);
  expect((await view(`/agents?ids=${sixty.join(',')}`)).status).toBe(200);
  for (const bad of [[...sixty, 'id60'].join(','), 'probe,probe', 'bad.id', '', 'probe&q=P', 'probe&cursor=x'])
    for (const kind of ['agents', 'members']) expect((await view(`/${kind}?ids=${bad}`)).status, `${kind} ${bad}`).toBe(400);
  // The labels view answers the same rows with label fields only (no live status, contact or usage).
  const labels = await view('/agents?view=labels&ids=probe,retired,missing');
  expect(labels.status).toBe(200);
  expect(labels.body.agents.map((a: { id: string; name: string; revokedAt: number | null }) => [a.id, a.name, a.revokedAt]).sort()).toEqual([['probe', 'Probe', null], ['retired', 'Retired', 5]]);
  for (const row of labels.body.agents) expect(Object.keys(row).sort()).toEqual(['createdAt', 'id', 'name', 'operatorId', 'operatorName', 'operatorPhoto', 'personaChoice', 'revokedAt']);
  const walked = await view('/agents?view=labels');
  expect(walked.status).toBe(200);
  expect(walked.body.agents.map((a: { id: string }) => a.id)).toContain('probe');
  for (const bad of ['/agents?view=full', '/agents?view=labels&view=labels', '/agents?view=labels&ids=probe&q=P']) expect((await view(bad)).status, bad).toBe(400);
  // Lookups keep the directory's authorization: people outside the project are refused.
  for (const actor of ['uninvited', 'removedPerson', 'removedMembership', 'otherProject'] as const) {
    for (const kind of ['agents', 'members']) expect((await view(`/${kind}?ids=probe`, s.tokens[actor])).status, `${actor} ${kind}`).not.toBe(200);
    expect((await view('/agents?view=labels', s.tokens[actor])).status, `${actor} labels`).not.toBe(200);
  }
}, 30_000);

test('member roster marks the actual owner and never promotes the first remaining member', async () => {
  const s = await fixture();
  const roster = () => call('GET', `/p/${A}/api/view/members`, s.tokens.member);
  const before = await roster();
  expect(before.status).toBe(200);
  expect(before.body.members.find((person: { id: string }) => person.id === s.owner.id)).toMatchObject({ owner: true });
  expect(before.body.members.find((person: { id: string }) => person.id === s.memberId)).toMatchObject({ owner: false });
  await profiles.doc(s.owner.id).update({ removedAt: 2 });
  const after = await roster();
  expect(after.status).toBe(200);
  expect(after.body.members.some((person: { owner: boolean }) => person.owner)).toBe(false);
});
