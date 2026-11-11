// Development-only harness: the production ProjectTasks component on a synthetic in-memory transport. Not the actual app
// and not the native backend; real authenticated app acceptance is a separate check.
import { createRoot } from 'react-dom/client';
import type { NativeTask, NativeTaskComment, NativeTaskMutation, NativeTaskMutationResult, NativeTaskPage } from '@mlswarm/contracts';
import { ApiError } from '../src/authorized-request';
import type { AgentRow } from '../src/api';
import type { TasksApi } from '../src/tasks-api';
import { ProjectTasks } from '../src/ui/ProjectTasks';
import '../src/styles.css';
import '../src/ui/theme.css';
import '../src/ui/profile-page.css';

if (!import.meta.env.DEV || !['127.0.0.1', 'localhost'].includes(location.hostname)) throw new Error('Local development only.');

const params = new URLSearchParams(location.search), disabled = params.get('disabled') === '1', readOnly = params.get('readonly') === '1' || disabled;
const loseReply = params.get('lostReply'), delay = Math.min(2000, Math.max(0, Number(params.get('delay')) || 150));
let lostReply = false;
const writes: NativeTaskMutation[] = [];
const now = Date.UTC(2026, 9, 24, 17, 30);
const agent = (id: string, name: string, operatorName: string, operatorId: string): AgentRow =>
  ({ id, name, operatorName, operatorId, createdAt: now, revokedAt: null, v2Contact: null, activity: null, usage: null, state: 'idle', freshUntil: null } as unknown as AgentRow);
const agents = [agent('agentA1', 'native-codex-2', 'Oron', 'p1'), agent('agentB2', 'native-claude-1', 'Oron', 'p1'), agent('agentC3', 'research-otter', 'Maya', 'p2')];
const people = [{ id: 'p1', name: 'Oron' }, { id: 'p2', name: 'Maya' }];
const task = (id: string, title: string, extra: Partial<NativeTask>): NativeTask => ({ id, projectId: 'demo', title, description: '', status: 'backlog', assignedAgentId: null, contributors: [], priority: 'normal', references: [], createdBy: { kind: 'person', id: 'p1' }, createdAt: now, updatedAt: now, revision: 1, ...extra });
const tasks: NativeTask[] = [
  task('t1', 'Store native tasks with atomic claims', { status: 'in_progress', assignedAgentId: 'agentA1', priority: 'high', revision: 4, updatedAt: now - 60_000,
    description: 'Persist tasks, comments and history in one transaction.\n\nDone when two agents claiming the same task leaves exactly one winner and retries replay the same result.',
    contributors: [{ kind: 'agent', id: 'agentB2' }, { kind: 'agent', id: 'agentC3' }],
    references: [{ id: 'r1', kind: 'pull_request', url: 'https://github.com/oronanschel/karma42-swarm/pull/412' }, { id: 'r2', kind: 'conversation', sourceId: 'thread-native-contract' }] }),
  task('t2', 'Replace GitHub Issue tools in agent prompts', { status: 'in_progress', assignedAgentId: 'agentB2', updatedAt: now - 300_000 }),
  task('t3', 'Write the retirement inventory', { updatedAt: now - 900_000 }),
  task('t4', 'Agree the task completion policy', { status: 'done', assignedAgentId: 'agentC3', updatedAt: now - 3_600_000 }),
];
const comments: NativeTaskComment[] = [{ id: 'c1', taskId: 't1', author: { kind: 'agent', id: 'agentA1' }, body: 'Claim transaction is in; working on replay receipts next.', createdAt: now - 120_000, updatedAt: now - 120_000 }];
// Opt-in pagination race fixture: each later page waits for the test's explicit completion.
// The normal visual/typing harness keeps its existing unpaginated transport.
const pagination = params.get('pagination') === '1';
const pageRequests: { status: NativeTask['status'] | undefined; finish: () => void }[] = [];
Object.assign(window, { taskPagination: {
  pending: () => pageRequests.map(request => request.status ?? 'all'),
  finish: (index: number) => { const request = pageRequests[index]; if (!request) throw new Error('Missing synthetic page request'); request.finish(); },
} });
const receipts = new Map<string, NativeTaskMutationResult>();
const wait = () => new Promise(r => setTimeout(r, delay));

const api: TasksApi = {
  list: async (cursor, status, assignedAgentId, search) => {
    if (!pagination) { await wait(); return { tasks: structuredClone(tasks), nextCursor: null }; }
    const visible = tasks.filter(item => (!status || item.status === status)
      && (assignedAgentId === undefined || item.assignedAgentId === assignedAgentId)
      && (!search || item.title.toLowerCase().includes(search.toLowerCase())));
    if (!cursor) return { tasks: structuredClone(visible.slice(0, 1)), nextCursor: 'page-2' };
    return new Promise<NativeTaskPage>(resolve => {
      const index = pageRequests.length;
      pageRequests.push({ status, finish: () => resolve({
        tasks: [task(`delayed-${index}`, `Delayed ${status ?? 'all'} page`, { status: status ?? 'backlog' })], nextCursor: null,
      }) });
    });
  },
  get: async id => { await wait(); const t = tasks.find(x => x.id === id); if (!t) throw new ApiError(404, 'Not found');
    return { task: structuredClone(t), permissions: { edit: true, editDescription: true, control: true, assign: 'any' as const }, comments: comments.filter(c => c.taskId === id), activity: [{ id: 'a1', taskId: id, actor: t.createdBy, action: 'create', revision: 1, at: t.createdAt }], nextCommentCursor: null, nextActivityCursor: null }; },
  mutate: async (m: NativeTaskMutation) => {
    writes.push(structuredClone(m));
    const evidence = document.getElementById('mutation-evidence');
    if (evidence) evidence.textContent = JSON.stringify(writes, null, 2);
    await wait();
    const replay = receipts.get(m.clientRequestId); if (replay) return structuredClone(replay);
    let result: NativeTaskMutationResult;
    if (m.operation === 'create') { const t = task(`t${tasks.length + 1}`, m.title, { assignedAgentId: m.assignedAgentId ?? null, updatedAt: Date.now() }); tasks.unshift(t); result = { task: t }; }
    else {
      const t = tasks.find(x => x.id === m.taskId)!;
      if (m.expectedRevision !== t.revision) throw new ApiError(409, 'Task changed', 'intent_conflict');
      if (m.operation === 'update') { const { operation: _o, taskId: _t, expectedRevision: _e, clientRequestId: _c, ...fields } = m;
        if (fields.status && ['in_progress', 'done'].includes(fields.status) && !t.assignedAgentId) throw new ApiError(400, 'Assign an agent first');
        Object.assign(t, fields); }
      if (m.operation === 'assign') t.assignedAgentId = m.assignedAgentId;
      if (m.operation === 'release') { t.assignedAgentId = null; t.status = 'backlog'; }
      if (m.operation === 'add_reference') t.references.push(m.reference);
      if (m.operation === 'remove_reference') t.references = t.references.filter(r => r.id !== m.referenceId);
      if (m.operation === 'edit_comment') { const existing = comments.find(c => c.id === m.commentId); if (existing) { existing.body = m.body; existing.updatedAt = Date.now(); } }
      let comment: NativeTaskComment | undefined;
      if (m.operation === 'comment') { comment = { id: `c${comments.length + 1}`, taskId: t.id, author: { kind: 'person', id: 'p1' }, body: m.body, createdAt: Date.now(), updatedAt: Date.now() }; comments.push(comment); }
      t.revision++; t.updatedAt = Date.now(); result = { task: structuredClone(t), ...(comment ? { comment } : {}) };
    }
    receipts.set(m.clientRequestId, result);
    if (!lostReply && m.operation === loseReply) { lostReply = true; throw new TypeError('Synthetic response lost after commit'); }
    return structuredClone(result);
  },
};
import { StrictMode } from 'react';
// Opt-in label lookup fixture: the walk stopped before agentC3, and t3 is assigned to a retired agent the walk never lists.
const labels = params.get('labels') === '1';
const lookups: string[][] = [];
if (labels) tasks.find(row => row.id === 't3')!.assignedAgentId = 'agentD4';
const retired = { ...agent('agentD4', 'retired-heron', 'Maya', 'p2'), revokedAt: now - 86_400_000 } as AgentRow;
const lookup = labels ? {
  agents: async (ids: string[]) => { lookups.push(ids); return [...agents, retired].filter(row => ids.includes(row.id)); },
  members: async (ids: string[]) => { lookups.push(ids); return people.filter(row => ids.includes(row.id)); },
} : undefined;
Object.assign(window, { labelLookups: lookups });
createRoot(document.getElementById('root')!).render(<StrictMode><main style={{ maxWidth: 1080, margin: '0 auto', padding: 24 }}><ProjectTasks api={api} agents={labels ? agents.slice(0, 2) : agents} people={people} lookup={lookup} readOnly={readOnly} disabledNotice={disabled} selfId="p1" projectId="demo" viewerUrl="https://karma42.ai/" active />
  <a href="#harness-end" id="harness-end">After task workspace</a>
  <details><summary>Synthetic mutation requests</summary><pre id="mutation-evidence">[]</pre></details>
</main></StrictMode>);
