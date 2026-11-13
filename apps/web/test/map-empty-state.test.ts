import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapEmptyState } from '../src/ui/communication-map/map-empty-state';

const base = { agents: 0, people: 0, rosterRead: false, rosterError: null, invite: false };

test('a refused or failed roster read never claims the project has no agents', () => {
  const refused = mapEmptyState({ ...base, rosterError: 'Updates will resume shortly. Please wait a moment.' });
  assert.equal(refused?.title, 'Couldn’t load agents');
  // A later refusal after a good read keeps the loaded agents on the map, so there is no empty notice at all.
  assert.equal(mapEmptyState({ ...base, agents: 3, rosterRead: true, rosterError: 'Too many requests.' }), null);
  assert.equal(mapEmptyState({ ...base, people: 1, rosterError: 'Too many requests.' }), null);
});

test('before the first roster read completes the map says it is loading', () => {
  assert.equal(mapEmptyState(base)?.title, 'Loading agents…');
  assert.equal(mapEmptyState({ ...base, invite: true })?.title, 'Loading agents…');
});

test('"No agents yet" only after a complete read returned none, and not beside the add-agent prompt', () => {
  assert.equal(mapEmptyState({ ...base, rosterRead: true })?.title, 'No agents yet');
  assert.equal(mapEmptyState({ ...base, rosterRead: true, invite: true }), null);
});
