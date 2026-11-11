import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupPersonalProjects, personalFilterChips } from '../src/ui/group-personal-projects';
import type { PersonalProjectEntry } from '../src/project-api';

const entry = (id: string, extra: Partial<PersonalProjectEntry> = {}) => ({ id, name: id, summary: '', role: 'member', execution: 'ready', ...extra }) as PersonalProjectEntry;

test('archived entries are excluded from every current group', () => {
  const groups = groupPersonalProjects([entry('a'), entry('b', { archived: true }), entry('c', { role: 'owner', archived: true })]);
  assert.deepEqual(groups.joined.map(p => p.id), ['a']);
  assert.equal(groups.owner.length + groups.waiting.length, 0);
});

test('chips: order, archived counted apart from All', () => {
  const current = [entry('a'), entry('b', { archived: true })];
  const chips = personalFilterChips(current, [entry('z', { archived: true })]);
  assert.deepEqual(chips.map(c => c.key), ['all', 'archived']);
  assert.equal(chips.find(c => c.key === 'all')!.count, 1);
  assert.equal(chips.find(c => c.key === 'archived')!.count, 1);
});
