import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { SessionUser } from '../src/session-identity';
import { authorizedRequest } from '../src/authorized-request';
import { isAccessLoss, isConflict, isTasksDisabled, isSettledRefusal, safeUrl, taskMutation, tasksApi, TASK_STATUSES } from '../src/tasks-api';
import { taskSourceHref, taskReferenceFromUrl, taskReferenceView, newestTaskSnapshot, singleFlight } from '../src/task-model';
import { ApiError } from '../src/authorized-request';

const user = { uid: 'person-1', getIdToken: async () => 'synthetic-token' } as unknown as SessionUser;

async function withServer(handler: (req: IncomingMessage, body: unknown, res: ServerResponse) => void, run: (base: string) => Promise<void>) {
  const server = createServer(async (req, res) => { let raw = ''; for await (const chunk of req) raw += chunk; handler(req, raw ? JSON.parse(raw) : undefined, res); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects`); }
  finally { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
}

test('task states include Canceled after Backlog, In progress and Done', () => {
  assert.deepEqual(TASK_STATUSES.map(s => s.id), ['backlog', 'in_progress', 'done', 'canceled']);
});

test('title-only create sends contract v1 shape with a null agent and one stable request ID across retries', async () => {
  const seen: unknown[] = [];
  await withServer((req, body, res) => {
    seen.push({ url: req.url, method: req.method, body });
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ task: { id: 't1', status: 'backlog', assignedAgentId: null, revision: 1 } }));
  }, async base => {
    const mutation = taskMutation({ operation: 'create', title: 'Write the plan', assignedAgentId: null }, 'req-1');
    await authorizedRequest(user, base, '/p1/tasks', mutation);
    await authorizedRequest(user, base, '/p1/tasks', mutation);
  });
  assert.equal(seen.length, 2);
  for (const call of seen) assert.deepEqual(call, { url: '/api/projects/p1/tasks', method: 'POST', body: { operation: 'create', title: 'Write the plan', assignedAgentId: null, clientRequestId: 'req-1' } });
});

test('a stale revision surfaces as a conflict the drawer can recognise', async () => {
  await withServer((_req, _body, res) => { res.writeHead(409, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'intent_conflict' })); }, async base => {
    await assert.rejects(authorizedRequest(user, base, '/p1/tasks', taskMutation({ operation: 'update', taskId: 't1', expectedRevision: 1, status: 'done' })), (error: unknown) => isConflict(error));
  });
});

test('fresh request IDs are generated per new mutation', () => {
  const a = taskMutation({ operation: 'claim', taskId: 't1', expectedRevision: 2 }), b = taskMutation({ operation: 'claim', taskId: 't1', expectedRevision: 2 });
  assert.notEqual(a.clientRequestId, b.clientRequestId);
});

test('only http(s) links render as links', () => {
  assert.equal(safeUrl('https://github.com/o/r/pull/3'), 'https://github.com/o/r/pull/3');
  assert.equal(safeUrl('javascript:alert(1)'), null);
  assert.equal(safeUrl('data:text/html,hi'), null);
  assert.equal(safeUrl('not a url'), null);
});

test('task client sends the selected profile and refuses after the signed-in account changes', async () => {
  const headers: (string | undefined)[] = [];
  let uid = 'person-1';
  await withServer((req, _body, res) => { headers.push(req.headers['x-mlswarm-profile-id'] as string | undefined); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ tasks: [], nextCursor: null })); }, async base => {
    const origin = base.replace('/api/projects', '');
    const g = globalThis as { fetch: typeof fetch };
    const realFetch = g.fetch;
    g.fetch = ((input: string, init?: RequestInit) => realFetch(input.startsWith('/') ? origin + input : input, init)) as typeof fetch;
    try {
      const api = tasksApi(user, 'p1', 'profile-7', () => uid);
      await api.mutate(taskMutation({ operation: 'create', title: 'x' }));
      uid = 'someone-else';
      await assert.rejects(api.mutate(taskMutation({ operation: 'create', title: 'y' })), (e: unknown) => e instanceof ApiError && e.status === 401);
    } finally { g.fetch = realFetch; }
  });
  assert.deepEqual(headers, ['profile-7']);
});

test('lost replies and server errors stay uncertain for identical retry; refusals settle; access loss clears', () => {
  assert.equal(isSettledRefusal(new ApiError(409, 'stale')), true);
  assert.equal(isSettledRefusal(new ApiError(400, 'bad')), true);
  assert.equal(isSettledRefusal(new ApiError(503, 'down')), false);
  assert.equal(isSettledRefusal(new TypeError('Failed to fetch')), false);
  assert.equal(isAccessLoss(new ApiError(403, 'gone')), true);
  assert.equal(isAccessLoss(new ApiError(404, 'gone')), true);
  assert.equal(isAccessLoss(new ApiError(409, 'stale')), false);
});

test('detail pages request older comments and history by cursor', async () => {
  const urls: (string | undefined)[] = [];
  await withServer((req, _body, res) => { urls.push(req.url); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ task: {}, comments: [], activity: [], nextCommentCursor: null, nextActivityCursor: null })); }, async base => {
    const origin = base.replace('/api/projects', ''), g = globalThis as { fetch: typeof fetch }, realFetch = g.fetch;
    g.fetch = ((input: string, init?: RequestInit) => realFetch(input.startsWith('/') ? origin + input : input, init)) as typeof fetch;
    try {
      const api = tasksApi(user, 'p1', 'profile-7', () => user.uid);
      await api.get('t1');
      await api.get('t1', { commentCursor: 'c50' });
      await api.get('t1', { activityCursor: 'a50' });
      await api.get('t1', { activityOrder: 'desc' });
      await api.get('t1', { activityId: 'a17' });
    } finally { g.fetch = realFetch; }
  });
  assert.deepEqual(urls, ['/api/projects/p1/tasks/t1', '/api/projects/p1/tasks/t1?commentCursor=c50', '/api/projects/p1/tasks/t1?activityCursor=a50', '/api/projects/p1/tasks/t1?activityOrder=desc', '/api/projects/p1/tasks/t1?activityId=a17']);
});

test('tasks_disabled is not mistaken for an edit conflict', () => {
  const off = new ApiError(409, 'Tasks are turned off', 'tasks_disabled');
  assert.equal(isTasksDisabled(off), true);
  assert.equal(isConflict(off), false);
  assert.equal(isConflict(new ApiError(409, 'stale', 'intent_conflict')), true);
  assert.equal(isSettledRefusal(off), true);
});


test('native source links keep same-project scope; external URLs cannot become source IDs', () => {
  const viewer = 'http://127.0.0.1:4300/viewer/';
  const message = taskReferenceFromUrl(viewer + '?project=p1&section=conversations&message=m1', 'r1', 'p1', viewer);
  assert.deepEqual(message, {id:'r1',kind:'message',sourceId:'m1'});
  assert.equal(taskSourceHref(message,'p1',viewer), viewer + '?project=p1&section=conversations&message=m1');
  assert.throws(() => taskReferenceFromUrl(viewer + '?project=p2&section=conversations&thread=t1','r1','p1',viewer), /this project/);
  assert.throws(() => taskReferenceFromUrl('javascript:alert(1)','r1','p1',viewer));
  assert.throws(() => taskReferenceFromUrl('http://example.test/result','r1','p1',viewer));
  assert.deepEqual(taskReferenceFromUrl('https://github.com/o/r/pull/42?diff=split','r2','p1',viewer), {id:'r2',kind:'pull_request',url:'https://github.com/o/r/pull/42?diff=split'});
  assert.equal(taskReferenceFromUrl('https://other.test/viewer/?project=p1&section=conversations&message=m1','r1','p1',viewer).kind,'result');
});


test('optional link labels describe the relationship without changing type or destination', () => {
  const url = 'https://github.com/oronanschel/karma42-swarm/pull/210?diff=split';
  const reference = taskReferenceFromUrl(url, 'r', undefined, undefined, '  Implementation reference  ');
  assert.deepEqual(reference, { id: 'r', kind: 'pull_request', url, label: 'Implementation reference' });
  assert.deepEqual(taskReferenceView(reference), { label: 'Pull request', text: 'Implementation reference', href: url, destination: 'oronanschel/karma42-swarm #210' });
  assert.deepEqual(taskReferenceView(taskReferenceFromUrl(url, 'r')), { label: 'Pull request', text: 'oronanschel/karma42-swarm #210', href: url });
  assert.deepEqual(taskReferenceFromUrl(url, 'r', undefined, undefined, '   '), { id: 'r', kind: 'pull_request', url });
  assert.throws(() => taskReferenceFromUrl(url, 'r', undefined, undefined, 'x'.repeat(121)), /120 characters/);
});

test('source labels keep source identity and unsafe destinations stay non-interactive', () => {
  const viewer = 'https://karma42.ai/viewer/';
  const reference = taskReferenceFromUrl(viewer + '?project=p1&section=conversations&message=m1', 'r', 'p1', viewer, 'Decision context');
  assert.deepEqual(reference, { id: 'r', kind: 'message', sourceId: 'm1', label: 'Decision context' });
  assert.deepEqual(taskReferenceView(reference), { label: 'Message', text: 'Decision context', href: null });
  assert.equal(taskSourceHref(reference, 'p1', viewer), viewer + '?project=p1&section=conversations&message=m1');
  assert.equal(taskReferenceView({ id: 'r', kind: 'result', url: 'javascript:alert(1)', label: 'Example' }).href, null);
  assert.equal(taskReferenceView({ id: 'r', kind: 'pull_request', url: 'https://other.test/a/b/pull/7' }).text, 'https://other.test/a/b/pull/7');
});


test('historical replay and stale read snapshots never regress the visible task revision', () => {
  const old = { id: 't1', projectId: 'p1', revision: 4, title: 'Original work' } as Parameters<typeof newestTaskSnapshot>[1];
  const current = { ...old, revision: 6, title: 'Changed by another member' };
  assert.equal(newestTaskSnapshot(current, old), current, 'replay keeps the newer visible task');
  assert.equal(newestTaskSnapshot(newestTaskSnapshot(old, current), old), current, 'late independent read cannot undo a newer response');
  assert.equal(newestTaskSnapshot(current, { ...current, revision: 7 }).revision, 7);
  assert.equal(newestTaskSnapshot(null, old), old);
  assert.equal(newestTaskSnapshot(current, { ...old, projectId: 'p2' }).projectId, 'p2', 'revision comparison cannot reuse another project');
});


test('task list sends state on every page and omits it for All states', async () => {
  const urls: (string | undefined)[] = [];
  await withServer((req, _body, res) => { urls.push(req.url); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ tasks: [], nextCursor: null })); }, async base => {
    const origin = base.replace('/api/projects', ''), g = globalThis as { fetch: typeof fetch }, realFetch = g.fetch;
    g.fetch = ((input: string, init?: RequestInit) => realFetch(input.startsWith('/') ? origin + input : input, init)) as typeof fetch;
    try {
      const api = tasksApi(user, 'p1');
      await api.list(null, 'done');
      await api.list('task_50', 'done');
      await api.list(null, 'backlog', null);
      await api.list('task_51', 'backlog', null);
      await api.list(null, 'done', 'agent-1');
      await api.list('task_52', 'done', 'agent-1');
      await api.list(null, 'backlog', null, ' Café & parser ');
      await api.list('task_53', 'backlog', null, 'Café & parser');
      await api.list();
    } finally { g.fetch = realFetch; }
  });
  assert.deepEqual(urls, ['/api/projects/p1/tasks?status=done', '/api/projects/p1/tasks?cursor=task_50&status=done', '/api/projects/p1/tasks?status=backlog&unassigned=true', '/api/projects/p1/tasks?cursor=task_51&status=backlog&unassigned=true', '/api/projects/p1/tasks?status=done&assignedAgentId=agent-1', '/api/projects/p1/tasks?cursor=task_52&status=done&assignedAgentId=agent-1', '/api/projects/p1/tasks?status=backlog&search=Caf%C3%A9+%26+parser&unassigned=true', '/api/projects/p1/tasks?cursor=task_53&status=backlog&search=Caf%C3%A9+%26+parser&unassigned=true', '/api/projects/p1/tasks']);
});

test('Show more admits one request per generation, even for two clicks before a rerender', () => {
  const flight = singleFlight();
  assert.equal(flight.start(1), true);
  assert.equal(flight.start(1), false);
  assert.equal(flight.start(2), true, 'a newer account, project or refresh may load while an older reply is pending');
  assert.equal(flight.end(1), false, 'the older reply does not release the newer request');
  assert.equal(flight.start(2), false);
  assert.equal(flight.end(2), true);
  assert.equal(flight.start(2), true);
});
