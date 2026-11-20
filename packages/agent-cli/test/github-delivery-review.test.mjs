import assert from 'node:assert/strict';
import test from 'node:test';
import { observeGitHubDelivery } from '../src/service/github-delivery-review.mjs';

const head = '0'.repeat(40);
const rootTree = '1'.repeat(40);
const dotGitHubTree = '2'.repeat(40);
const workflowsTree = '3'.repeat(40);
const pinnedBlob = '4'.repeat(40);
const otherHead = '5'.repeat(40);
const root = 'repos/owner/repo';
const app = { id: 15368 };
const repo = { id: 10, full_name: 'Owner/Repo' };
const candidate = { repository: 'owner/repo', headSha: head, pullRequest: 21 };
const policy = [{ name: 'Test', workflowId: 11, workflowPath: '.github/workflows/ci.yml', workflowBlobSha: pinnedBlob }];
const branch = 'agent/work';
const workflowRuns = `${root}/actions/workflows/11/runs?head_sha=${head}&branch=agent%2Fwork&event=push&per_page=100`;
const prPath = `${root}/pulls/21`;
const jobPath = `${root}/actions/runs/12/attempts/1/jobs?per_page=100`;
const suitePath = `${root}/check-suites/14`;
const checkPath = `${root}/check-runs/16`;

function fixture() {
  const pr = { number: 21, state: 'open', head: { sha: head, ref: branch, repo }, base: { repo } };
  const run = { id: 12, run_number: 13, run_attempt: 1, check_suite_id: 14, workflow_id: 11, head_sha: head, head_branch: branch,
    repository: repo, head_repository: repo, event: 'push', path: '.github/workflows/ci.yml@refs/heads/agent/work', status: 'completed', conclusion: 'success' };
  const job = { id: 15, run_id: 12, head_sha: head, name: 'Test', status: 'completed', conclusion: 'success', check_run_url: `https://api.github.com/${checkPath}` };
  const check = { id: 16, head_sha: head, name: 'Test', status: job.status, conclusion: job.conclusion, check_suite: { id: 14 }, app };
  const suite = { id: 14, head_sha: head, head_branch: branch, repository: repo, app };
  const workflow = { path: 'ci.yml', type: 'blob', mode: '100644', sha: pinnedBlob };
  const tree = (sha, entry) => ({ sha, truncated: false, tree: [entry] });
  const directory = (path, sha) => ({ path, type: 'tree', mode: '040000', sha });
  const replies = new Map([
    [prPath, pr],
    [`${root}/git/commits/${head}`, { sha: head, tree: { sha: rootTree } }],
    [`${root}/git/trees/${rootTree}`, tree(rootTree, directory('.github', dotGitHubTree))],
    [`${root}/git/trees/${dotGitHubTree}`, tree(dotGitHubTree, directory('workflows', workflowsTree))],
    [`${root}/git/trees/${workflowsTree}`, tree(workflowsTree, workflow)],
    [workflowRuns, { workflow_runs: [run], total_count: 1 }],
    [suitePath, suite],
    [jobPath, { jobs: [job], total_count: 1 }],
    [checkPath, check],
  ]);
  const calls = [];
  const observe = (transform = value => value) => observeGitHubDelivery(candidate, policy, { now: () => 100,
    request: async (path, options) => {
      calls.push(path);
      assert.deepEqual(Object.keys(options), ['signal']);
      assert.ok(replies.has(path), `Unexpected GitHub GET: ${path}`);
      return { status: 'ok', body: transform(replies.get(path), path, calls.filter(call => call === path).length), more: false };
    } });
  return { observe, calls, pr, job, check, run, suite, workflow, replies };
}

test('verifies an exact-head push check with pinned workflow and suite identity', async () => {
  const { observe, calls } = fixture();
  assert.deepEqual(await observe(), { status: 'verified', observedAt: 100, actualHeadSha: head,
    checks: [{ name: 'Test', status: 'verified', runId: 12, runAttempt: 1, jobId: 15, checkRunId: 16 }] });
  assert.equal(calls[0], prPath);
  assert.equal(calls.at(-1), prPath);
  assert.equal(calls.filter(path => path === workflowRuns).length, 2);
});

test('does not verify a same-named check lacking the expected workflow, app, or exact commit', async () => {
  for (const change of [
    ({ check }) => { check.app = { id: 13 }; },
    ({ check }) => { check.check_suite = { id: 99 }; },
    ({ job }) => { job.head_sha = otherHead; },
    ({ workflow }) => { workflow.sha = otherHead; },
    ({ workflow }) => { workflow.mode = '120000'; },
    ({ run }) => { run.path = '.github/workflows/other.yml'; },
    ({ run }) => { run.workflow_id = 123; },
    ({ run }) => { run.event = 'pull_request'; },
    ({ run }) => { run.event = 'pull_request_target'; },
    ({ run }) => { run.referenced_workflows = [{ path: 'owner/repo/.github/workflows/reusable.yml@main' }]; },
    ({ suite }) => { suite.repository = { ...repo, id: 999 }; },
    ({ job }) => { job.check_run_url = `https://other.invalid/${checkPath}`; },
    ({ pr }) => { pr.head.repo = { id: 99, full_name: 'outside/repo' }; },
  ]) {
    const fake = fixture();
    change(fake);
    assert.equal((await fake.observe()).status, 'unavailable');
  }
});

test('a changed PR head or a rerun invalidates prior success', async () => {
  const fake = fixture();
  const changedHead = await fake.observe((value, path, count) => path === prPath && count === 2
    ? { ...value, head: { ...value.head, sha: otherHead } } : value);
  assert.equal(changedHead.status, 'stale');
  assert.equal(changedHead.actualHeadSha, otherHead);

  const rerun = fixture();
  const changedAttempt = await rerun.observe((value, path, count) => path === workflowRuns && count === 2
    ? { ...value, workflow_runs: [{ ...rerun.run, status: 'queued', run_attempt: 2 }] } : value);
  assert.equal(changedAttempt.status, 'unavailable');
});

test('pending or failed checks do not count as verified', async () => {
  const pending = fixture();
  pending.run.status = 'in_progress';
  pending.run.conclusion = null;
  assert.equal((await pending.observe()).status, 'pending');
  const failed = fixture();
  failed.check.conclusion = failed.job.conclusion = failed.run.conclusion = 'failure';
  assert.equal((await failed.observe()).status, 'failed');
});

test('inconclusive provider results remain unavailable', async () => {
  for (const conclusion of ['timed_out', 'cancelled', 'skipped', 'neutral', 'stale', 'startup_failure', null]) {
    const fake = fixture();
    fake.check.conclusion = fake.job.conclusion = fake.run.conclusion = conclusion;
    assert.equal((await fake.observe()).status, 'unavailable');
  }
});

test('refresh detects a changed PR even without configured checks', async () => {
  const { pr } = fixture();
  const observe = () => observeGitHubDelivery(candidate, [], { now: () => 100,
    request: async path => {
      assert.equal(path, prPath);
      return { status: 'ok', body: pr };
    } });
  assert.deepEqual(await observe(), { status: 'unavailable', observedAt: 100, actualHeadSha: head, checks: [] });
  pr.head.sha = otherHead;
  assert.deepEqual(await observe(), { status: 'stale', staleReason: 'head_changed', observedAt: 100, actualHeadSha: otherHead, checks: [] });
});

test('a closed pull request is stale even if its head still matches', async () => {
  const fake = fixture();
  fake.pr.state = 'closed';
  const result = await fake.observe();
  assert.equal(result.status, 'stale');
  assert.equal(result.staleReason, 'closed');
  assert.equal(result.actualHeadSha, head);
});
