import test from 'node:test';
import assert from 'node:assert/strict';
import { projectGuidanceForTurn, TALK_FIRST } from '../src/native-worker-adapter.mjs';

const participation = { project: { nativeTasksEnabled: true, nativeTeamsEnabled: false } };

test('the first turn asks for one note to teammates before code', () => {
  const text = projectGuidanceForTurn(participation, { card: false, first: true });
  assert.ok(text.startsWith('## Talk first\n\n' + TALK_FIRST));
  assert.match(text, /your task and your first message are how they see what you took/);
});

test('later turns do not repeat it', () => {
  assert.doesNotMatch(projectGuidanceForTurn(participation, { card: false }), /## Talk first/);
});
