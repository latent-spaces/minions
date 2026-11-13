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

test('each turn carries the shared update aim at the owner\'s pace and says when an update is due', () => {
  const card = { name: 'p', mission: 'm', rules: 'r', repoUrl: 'https://github.com/o/r', mergeApproval: 'humans' };
  const quiet = projectGuidanceForTurn({ project: card });
  assert.match(quiet, /about one update every 5 minutes of work\. You are not asked for one now/);
  assert.match(projectGuidanceForTurn({ project: card, updateEveryMinutes: 30 }), /about one update every 30 minutes of work/);
  assert.doesNotMatch(quiet, /Steps:/);
  // The one asked agent gets the steps in the turn itself (owner, 12 November 2026).
  const due = projectGuidanceForTurn({ project: card, updateDue: true });
  assert.match(due, /You are the one agent asked to post the next one/);
  assert.match(due, /before you return WORK_NEXT: waiting/);
  assert.match(due, /Report only this job's work: pull requests and tasks from before it are not news.*Say only what you checked yourself/);
  assert.match(due, /1\. Get one image.*chromium\.launch\(\{ args: \['--single-process'\] \}\).*NODE_PATH=.*node shot\.cjs.*2\. upload_project_image.*clientRequestId.*3\. publish_project_update.*title \(the headline, at most 60 characters\), body \(one sentence, at most 140 characters; count them before you send, a longer one is refused\)/);
  assert.doesNotMatch(due, /only for that/);
  // Where the project allows slides, a short set to swipe is the normal shape (owner, 12 November 2026).
  const slides = projectGuidanceForTurn({ project: card, updateDue: true, updateSlides: true });
  assert.match(slides, /1\. Make 2 to 4 slides.*Slide 1 says the whole result in one line.*The last slide says what the person has to do.*2\. upload_project_image once for each slide.*3\. publish_project_update.*the others in moreSlides in reading order/);
  assert.doesNotMatch(slides, /Get one image/);
  const nudge = projectGuidanceForTurn({ project: card, updateDue: true }, { updateNudge: true });
  assert.match(nudge, /Your last turn ended without the team's update\. This turn is only for that/);
  assert.match(nudge, /Steps: 1\./);
  const closing = projectGuidanceForTurn({ project: card, updateDue: true, updateClosing: true });
  assert.match(closing, /The job's time is almost up, and you are the one agent asked to post the team's closing update/);
  assert.match(closing, /Steps: 1\./);
  assert.match(closing, /listing what the whole team finished in this job: the pull requests merged since it started \(gh pr list --state merged\)/);
  const dated = projectGuidanceForTurn({ project: card, updateDue: true, updateClosing: true, updateJobStartedAt: Date.UTC(2026, 10, 12, 12, 27, 16) });
  assert.match(dated, /since it started at 2026-11-12T12:27:16Z \(gh pr list --state merged --search "merged:>=2026-11-12T12:27:16Z"\)/);
  assert.match(dated, /work merged before this job started is not this job's result/);
  assert.doesNotMatch(dated, /Headlines already posted/);
  const later = projectGuidanceForTurn({ project: card, updateDue: true, updateClosing: true, updatePostedTitles: ['The game can be won'] });
  assert.match(later, /Headlines already posted in this job \(JSON data\): \["The game can be won"\]\. People have seen those\..*in words those headlines did not use/);
  assert.match(closing, /git fetch -q origin HEAD && mkdir merged && git archive FETCH_HEAD \| tar -x -C merged/);
  assert.doesNotMatch(projectGuidanceForTurn({ project: card, updateDue: false, updateClosing: true }), /closing update/);
  assert.doesNotMatch(projectGuidanceForTurn({ project: card }, { updateNudge: true }), /only for that/);
});
