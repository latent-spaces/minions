import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NativeTask } from '@mlswarm/contracts';
import { nestTasks, newestTaskSnapshot } from '../src/task-model';
import { formatRoute, parseRoute, taskRoute } from '../src/route';

const PROJECT = 'a'.repeat(64);
let at = 0;
const task = (id: string, parentId?: string, extra: Partial<NativeTask> = {}): NativeTask => ({ id, projectId: PROJECT, title: id, description: '', status: 'backlog', assignedAgentId: null,
  contributors: [], priority: 'normal', references: [], createdBy: { kind: 'person', id: 'p' }, createdAt: ++at, updatedAt: at, revision: 1, ...(parentId ? { parentId } : {}), ...extra });

test('list rows nest subtasks under a loaded parent, oldest first, and a collapsed parent hides its whole branch', () => {
  const rows = [task('c2', 'root'), task('root'), task('g', 'c1'), task('c1', 'root'), task('orphan', 'missing')];
  rows[3].createdAt = 0; // c1 before c2
  assert.deepEqual(nestTasks(rows, new Set()).map(r => [r.task.id, r.depth]), [['root', 0], ['c1', 1], ['g', 2], ['c2', 1], ['orphan', 0]]);
  assert.deepEqual(nestTasks(rows, new Set(['root'])).map(r => r.task.id), ['root', 'orphan']);
  assert.deepEqual(nestTasks(rows, new Set(['c1'])).map(r => r.task.id), ['root', 'c1', 'c2', 'orphan']);
  assert.deepEqual(nestTasks(rows, new Set()).find(r => r.task.id === 'root')!.children.map(c => c.id), ['c1', 'c2']);
});

test('a corrupt parent cycle still shows its rows', () => {
  assert.deepEqual(nestTasks([task('x', 'y'), task('y', 'x')], new Set()).map(r => r.task.id).sort(), ['x', 'y']);
});

test('a task page is a Tasks location that survives reloads; other sections drop it', () => {
  const search = formatRoute(taskRoute(PROJECT, 'task_abc'));
  assert.equal(search, `?project=${PROJECT}&task=task_abc`);
  assert.deepEqual(parseRoute(search), { view: 'project', projectId: PROJECT, section: 'overview', thread: null, agent: null, q: null, task: 'task_abc' });
  assert.equal(parseRoute(`?project=${PROJECT}&section=agents&task=task_abc`).view === 'project' && 'task' in parseRoute(`?project=${PROJECT}&section=agents&task=task_abc`), false);
  assert.equal('task' in parseRoute(`?project=${PROJECT}&task=../x`), false);
});

test('a mutation receipt keeps the subtask ring the row already had; a read replaces it', () => {
  const row = { ...task('p'), revision: 2, subtaskProgress: { done: 1, total: 3 } } as NativeTask;
  const receipt = { ...task('p'), revision: 3 } as NativeTask;
  assert.deepEqual(newestTaskSnapshot(row, receipt).subtaskProgress, { done: 1, total: 3 });
  assert.equal(newestTaskSnapshot(row, receipt).revision, 3);
  const read = { ...receipt, subtaskProgress: { done: 2, total: 3 } } as NativeTask;
  assert.deepEqual(newestTaskSnapshot(row, read).subtaskProgress, { done: 2, total: 3 });
  assert.equal(newestTaskSnapshot({ ...row, id: 'other' } as NativeTask, receipt).subtaskProgress, undefined);
});
