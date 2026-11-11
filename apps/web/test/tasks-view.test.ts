import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TASKS_VIEW_KEY, readTasksView, statusChangeBlock, writeTasksView } from '../src/task-model';

test('the Tasks view defaults to the list and only a saved "board" selects the board', () => {
  assert.equal(readTasksView(null), 'list');
  assert.equal(readTasksView({ getItem: () => null }), 'list');
  assert.equal(readTasksView({ getItem: () => 'anything-else' }), 'list');
  assert.equal(readTasksView({ getItem: key => key === TASKS_VIEW_KEY ? 'board' : null }), 'board');
});

test('the chosen view is written under one key and blocked storage keeps the visit working', () => {
  const saved: Record<string, string> = {};
  writeTasksView({ setItem: (key, value) => { saved[key] = value; } }, 'board');
  assert.deepEqual(saved, { [TASKS_VIEW_KEY]: 'board' });
  writeTasksView({ setItem: () => { throw new Error('blocked'); } }, 'list');
  assert.equal(readTasksView({ getItem: () => { throw new Error('blocked'); } }), 'list');
});

test('board moves follow the task page rules: reopen canceled work first, assign before starting or completing', () => {
  assert.equal(statusChangeBlock({ status: 'canceled', assignedAgentId: null }, 'done'), 'Reopen to Backlog first');
  assert.equal(statusChangeBlock({ status: 'canceled', assignedAgentId: null }, 'backlog'), null);
  assert.equal(statusChangeBlock({ status: 'backlog', assignedAgentId: null }, 'in_progress'), 'Assign an agent before starting or completing this task');
  assert.equal(statusChangeBlock({ status: 'backlog', assignedAgentId: null }, 'canceled'), null);
  assert.equal(statusChangeBlock({ status: 'backlog', assignedAgentId: 'agent-1' }, 'done'), null);
  assert.equal(statusChangeBlock({ status: 'in_progress', assignedAgentId: 'agent-1' }, 'in_progress'), null);
});
