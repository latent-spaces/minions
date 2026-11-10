import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LABEL_BATCH, LABEL_TTL_MS, labelsDue, recordLabels, type LabelEntry } from '../src/label-lookup';

type Row = { id: string; name: string };

test('asks only for shown ids the walk has not listed, once each, in batches the server accepts', () => {
  const listed = new Map([['a0', { id: 'a0', name: 'Listed' }]]);
  const shown = ['a0', ...Array.from({ length: 130 }, (_, i) => `a${i + 1}`), 'a1', 'a2'];
  const batches = labelsDue(shown, listed, new Map<string, LabelEntry<Row>>(), 0);
  assert.deepEqual(batches.map(b => b.length), [LABEL_BATCH, LABEL_BATCH, 10]);
  assert.equal(new Set(batches.flat()).size, 130);
  assert.ok(!batches.flat().includes('a0'));
});

test('a page of 50 actors the walk has not reached is labelled with one request', () => {
  // One page of tasks: 50 assignees and contributors, none in the walk's first 500 agents.
  const shown = Array.from({ length: 50 }, (_, i) => `late${i}`);
  assert.equal(labelsDue(shown, new Map(), new Map<string, LabelEntry<Row>>(), 0).length, 1);
});

test('answered ids, found or absent, are not asked again until they are stale', () => {
  const cache = new Map<string, LabelEntry<Row>>();
  recordLabels(cache, ['a1', 'gone'], [{ id: 'a1', name: 'One' }, { id: 'unasked', name: 'Ignored' }], 1_000);
  assert.deepEqual([...cache], [['a1', { row: { id: 'a1', name: 'One' }, at: 1_000 }], ['gone', { row: null, at: 1_000 }]]);
  assert.deepEqual(labelsDue(['a1', 'gone', 'new'], new Map(), cache, 1_000 + LABEL_TTL_MS - 1), [['new']]);
  assert.deepEqual(labelsDue(['a1', 'gone'], new Map(), cache, 1_000 + LABEL_TTL_MS), [['a1', 'gone']]);
});

test('nothing shown, or everything already listed, sends no request', () => {
  const listed = new Map([['a1', { id: 'a1', name: 'One' }]]);
  assert.deepEqual(labelsDue([], listed, new Map<string, LabelEntry<Row>>(), 0), []);
  assert.deepEqual(labelsDue(['a1'], listed, new Map<string, LabelEntry<Row>>(), 0), []);
});
