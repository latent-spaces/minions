import { createGitHubRequest } from './github-observations.mjs';
import { canonicalGithubRepo } from '../github-repository.mjs';

const GITHUB_ACTIONS = 15368;
const sha = /^[a-f0-9]{40}$/;
const workflowPath = /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/;
const id = value => Number.isSafeInteger(value) && value > 0;
const sameRepo = (row, repo, repoId) => row?.id === repoId
  && typeof row.full_name === 'string' && row.full_name.toLowerCase() === repo;
const pending = new Set(['queued', 'in_progress', 'waiting', 'pending', 'requested']);
function outcome(row) {
  if (pending.has(row?.status)) return 'pending';
  if (row?.status !== 'completed') return 'unavailable';
  if (row.conclusion === 'success') return 'verified';
  if (row.conclusion === 'failure') return 'failed';
  return 'unavailable';
}

export async function observeGitHubDelivery(candidate, policy, {
  request = createGitHubRequest(), signal = AbortSignal.timeout(20_000), now = Date.now,
} = {}) {
  const observedAt = now();
  let actualHeadSha = null;
  const report = (status, checks = policy.map(({ name }) => ({ name, status: 'unavailable' }))) =>
    ({ status, observedAt, actualHeadSha, checks });
  const canonical = canonicalGithubRepo(candidate.repository.startsWith('https://') ? candidate.repository : `https://github.com/${candidate.repository}`);
  if (!canonical || !sha.test(candidate.headSha) || !id(candidate.pullRequest) || policy.length > 20
    || policy.some(check => !id(check.workflowId) || !workflowPath.test(check.workflowPath) || !sha.test(check.workflowBlobSha))) return report('unavailable');

  const repo = new URL(canonical).pathname.slice(1);
  const root = `repos/${repo}`;
  const prPath = `${root}/pulls/${candidate.pullRequest}`;
  const head = candidate.headSha;
  const read = async path => {
    const result = await request(path, { signal });
    if (result.status !== 'ok' || result.more) throw new Error('GitHub evidence is unavailable or incomplete.');
    return result.body;
  };
  // All suffixes are built locally. Never follow URLs, refs or next-page links from GitHub responses.
  const readPull = () => read(prPath);
  try {
    const pr = await readPull();
    if (pr?.number !== candidate.pullRequest || !sha.test(pr?.head?.sha) || !id(pr?.base?.repo?.id)
      || !sameRepo(pr.base.repo, repo, pr.base.repo.id)) return report('unavailable');
    actualHeadSha = pr.head.sha;
    if (pr.state !== 'open' || actualHeadSha !== head) return { ...report('stale'), staleReason: pr.state === 'closed' ? 'closed' : 'head_changed' };
    if (!policy.length) return report('unavailable');
    const repoId = pr.base.repo.id;
    const branch = pr.head.ref;
    if (!sameRepo(pr.head.repo, repo, repoId) || typeof branch !== 'string' || !branch || branch.length > 255) return report('unavailable');

    const cached = new Map();
    const once = (key, operation) => {
      if (!cached.has(key)) cached.set(key, operation());
      return cached.get(key);
    };
    const trees = path => once(path, async () => {
      // Use Git trees to require an ordinary file. The Contents endpoint can dereference symlinks.
      const commit = await once(head, () => read(`${root}/git/commits/${head}`));
      let treeSha = commit?.tree?.sha;
      if (commit?.sha !== head || !sha.test(treeSha)) throw new Error('Invalid commit tree.');
      const names = path.split('/');
      for (const [at, name] of names.entries()) {
        const tree = await once(treeSha, () => read(`${root}/git/trees/${treeSha}`));
        if (tree?.sha !== treeSha || tree.truncated !== false || !Array.isArray(tree.tree)) throw new Error('Incomplete Git tree.');
        const entries = tree.tree.filter(row => row?.path === name);
        const entry = entries[0];
        if (entries.length !== 1 || !sha.test(entry.sha)) return null;
        if (at === names.length - 1) return entry.type === 'blob' && entry.mode === '100644' ? entry.sha : null;
        if (entry.type !== 'tree' || entry.mode !== '040000') return null;
        treeSha = entry.sha;
      }
      return null;
    });
    const listRuns = async workflowId => {
      const query = new URLSearchParams({ head_sha: head, branch, event: 'push', per_page: '100' });
      const list = await read(`${root}/actions/workflows/${workflowId}/runs?${query}`);
      const rows = list?.workflow_runs;
      if (!Array.isArray(rows) || list.total_count !== rows.length || rows.length > 100 || rows.some(row =>
        !id(row?.id) || !id(row.run_number) || !id(row.run_attempt) || row.workflow_id !== workflowId || row.event !== 'push'
        || row.head_sha !== head || row.head_branch !== branch || !sameRepo(row.repository, repo, repoId)
        || !sameRepo(row.head_repository, repo, repoId))
        || new Set(rows.map(row => row.run_number)).size !== rows.length) throw new Error('Incomplete workflow run identity.');
      return rows.sort((a, b) => b.run_number - a.run_number)[0];
    };
    const inspect = async ({ name, workflowId, workflowPath: path, workflowBlobSha }) => {
      const unavailable = { name, status: 'unavailable' };
      try {
        if (await trees(path) !== workflowBlobSha) return unavailable;
        const run = await once(workflowId, () => listRuns(workflowId));
        if (!run) return { name, status: 'pending' };
        if (![path, `${path}@${branch}`, `${path}@refs/heads/${branch}`].includes(run.path)
          || !id(run.check_suite_id) || (run.referenced_workflows !== undefined
            && (!Array.isArray(run.referenced_workflows) || run.referenced_workflows.length))) return unavailable;
        if (outcome(run) === 'pending') return { name, status: 'pending', runId: run.id, runAttempt: run.run_attempt };
        const suite = await once(`suite:${run.check_suite_id}`, () => read(`${root}/check-suites/${run.check_suite_id}`));
        if (suite?.id !== run.check_suite_id || suite?.app?.id !== GITHUB_ACTIONS || suite.head_sha !== head
          || suite.head_branch !== branch || !sameRepo(suite.repository, repo, repoId)) return unavailable;
        const list = await once(`jobs:${run.id}`, () => read(`${root}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`));
        if (!Array.isArray(list?.jobs) || list.total_count !== list.jobs.length || list.jobs.length > 100) return unavailable;
        const matches = list.jobs.filter(job => job?.name === name);
        const job = matches[0];
        const apiPrefix = `https://api.github.com/${root}/check-runs/`;
        const checkId = typeof job?.check_run_url === 'string' && job.check_run_url.toLowerCase().startsWith(apiPrefix)
          ? Number(job.check_run_url.slice(apiPrefix.length)) : null;
        if (matches.length !== 1 || !id(job.id) || job.run_id !== run.id || job.head_sha !== head || !id(checkId)
          || job.check_run_url.toLowerCase() !== `${apiPrefix}${checkId}`) return unavailable;
        const check = await read(`${root}/check-runs/${checkId}`);
        if (check?.id !== checkId || check?.name !== name || check?.head_sha !== head || check?.app?.id !== GITHUB_ACTIONS
          || check?.check_suite?.id !== suite.id || check.status !== job.status || check.conclusion !== job.conclusion) return unavailable;
        // Avoid retaining an earlier attempt's success while a rerun or fresher push is underway.
        const latest = await once(`latest:${workflowId}`, () => listRuns(workflowId));
        if (latest?.id !== run.id || latest.run_attempt !== run.run_attempt || latest.status !== run.status || latest.conclusion !== run.conclusion) return unavailable;
        return { name, status: outcome(check), runId: run.id, runAttempt: run.run_attempt, jobId: job.id, checkRunId: checkId };
      } catch {
        return unavailable;
      }
    };
    // Cap parallel reads of distinct workflows. The total deadline bounds this inspection even with slow gh calls.
    const checks = [];
    for (let start = 0; start < policy.length; start += 3) checks.push(...await Promise.all(policy.slice(start, start + 3).map(inspect)));
    if (signal.aborted) return report('unavailable');
    const current = await readPull();
    if (current?.number !== candidate.pullRequest || !sha.test(current?.head?.sha) || !sameRepo(current?.base?.repo, repo, repoId)) return report('unavailable');
    actualHeadSha = current.head.sha;
    if (current.state !== 'open' || actualHeadSha !== head) return { ...report('stale'), staleReason: current.state === 'closed' ? 'closed' : 'head_changed' };
    if (current.head.ref !== branch || !sameRepo(current.head.repo, repo, repoId)) return report('unavailable');
    const statuses = new Set(checks.map(check => check.status));
    return report(statuses.has('failed') ? 'failed' : statuses.has('unavailable') ? 'unavailable' : statuses.has('pending') ? 'pending' : 'verified', checks);
  } catch {
    return report('unavailable');
  }
}
