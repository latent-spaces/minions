import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeTaskGuidance, nativeTeamGuidance, projectGuidanceForTurn } from '../src/native-worker-adapter.mjs';

test('each worker turn states whether optional native tasks are on, defaulting to on, and never offers a GitHub Issues fallback', () => {
  const card = { name: 'p', mission: 'm', rules: 'r', repoUrl: 'https://github.com/o/r', mergeApproval: 'humans' };
  assert.match(projectGuidanceForTurn({ project: card }), /Native tasks are ON/);
  assert.match(projectGuidanceForTurn({ project: { ...card, nativeTasksEnabled: true } }), /Native tasks are ON/);
  const off = projectGuidanceForTurn({ project: { ...card, nativeTasksEnabled: false } });
  assert.match(off, /Native tasks are OFF/);
  assert.match(off, /do not create, claim or update tasks/);
  assert.match(off, /do not use GitHub Issues as a tracker/);
  assert.doesNotMatch(nativeTaskGuidance(false), /claim_task|find_github_work/);
  // Pinned mission prompts don't change; this per-turn line is what reaches running workers.
  assert.match(nativeTaskGuidance(true), /list_tasks.*claim_task/);
  assert.match(nativeTaskGuidance(true), /WORK_NEXT: waiting/);
  assert.doesNotMatch(nativeTaskGuidance(true), /Task counts/);
  assert.match(nativeTaskGuidance(true, { assignedToYouOpen: 2, unassignedBacklog: 5 }), /2 open task\(s\) assigned to you, 5 unassigned in Backlog/);
  assert.match(projectGuidanceForTurn({ project: card, taskCounts: { assignedToYouOpen: 0, unassignedBacklog: 3 } }), /0 open task\(s\) assigned to you, 3 unassigned/);
  assert.doesNotMatch(nativeTaskGuidance(false, { assignedToYouOpen: 2, unassignedBacklog: 5 }), /Task counts/);
});

test('team guidance defaults OFF independently of tasks and states self membership and member archive/restore', () => {
  assert.match(projectGuidanceForTurn({ project: {} }), /Native teams are OFF/);
  const on = projectGuidanceForTurn({ project: { nativeTeamsEnabled: true, nativeTasksEnabled: false } });
  assert.match(on, /Native teams are ON/);
  assert.match(on, /Native tasks are OFF/);
  assert.match(on, /Any current member may archive or restore/);
  assert.match(nativeTeamGuidance(true), /only for yourself/);
});

test('each turn carries the shared five-minute update aim and says when an update is due', () => {
  const card = { name: 'p', mission: 'm', rules: 'r', repoUrl: 'https://github.com/o/r', mergeApproval: 'humans' };
  const quiet = projectGuidanceForTurn({ project: card });
  assert.match(quiet, /one update about every five minutes of work, one for the whole team, not one per agent/);
  assert.doesNotMatch(quiet, /due now/);
  const due = projectGuidanceForTurn({ project: card, updateDue: true });
  assert.match(due, /An update is due now/);
  assert.match(due, /publish_project_update \(an image is required\)/);
});
