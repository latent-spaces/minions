import { createGitHubRequest } from './github-observations.mjs';
import { githubRepositoryUrl, isGithubRepositoryUrl } from '../github-repository.mjs';

const hash = /^[a-f0-9]{64}$/;
const accountId = value => Number.isSafeInteger(value) && value > 0;
const fail = code => Object.assign(new Error(code), { code });
const nameFor = target => `MyLittleSwarm merge access ${target.projectId}`;
// REST contract pinned to X-GitHub-Api-Version 2026-03-10. Individual User actors
// and PR-only bypass: https://docs.github.com/en/rest/repos/rules#create-a-repository-ruleset
export function mergeAccessRuleset(target) {
  return {
    name: nameFor(target), target: 'branch', enforcement: 'active',
    bypass_actors: target.allowedGithubIds.slice().sort((a, b) => a - b).map(actor_id => ({ actor_id, actor_type: 'User', bypass_mode: 'pull_request' })),
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH', 'refs/heads/main'], exclude: [] } },
    // Pull-request-only bypass is confined to this access rule. Separate required
    // checks, reviews and organization rules continue to apply to these people.
    rules: [{ type: 'creation' }, { type: 'update', parameters: { update_allows_fetch_and_merge: false } }, { type: 'deletion' }, { type: 'non_fast_forward' }],
  };
}
const sorted = value => JSON.stringify(value, (_key, row) => row && typeof row === 'object' && !Array.isArray(row) ? Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))) : row);
function matches(body, expected) {
  if (!body || body.name !== expected.name || body.target !== 'branch' || body.enforcement !== 'active') return false;
  const actors = body.bypass_actors?.map(row => ({ actor_id: row.actor_id, actor_type: row.actor_type, bypass_mode: row.bypass_mode })).sort((a, b) => a.actor_id - b.actor_id);
  const rules = body.rules?.slice().sort((a, b) => a.type.localeCompare(b.type));
  const conditions = body.conditions?.ref_name && { ...body.conditions, ref_name: { include: body.conditions.ref_name.include?.slice().sort(), exclude: body.conditions.ref_name.exclude?.slice().sort() } };
  const expectedConditions = { ref_name: { include: expected.conditions.ref_name.include.slice().sort(), exclude: [] } };
  return sorted(actors) === sorted(expected.bypass_actors) && sorted(rules) === sorted(expected.rules.slice().sort((a, b) => a.type.localeCompare(b.type))) && sorted(conditions) === sorted(expectedConditions);
}

/** Called only from the approved owner's existing repository synchronization.
 * The latest cloud target is checked before each GitHub mutation and reporting.
 * Failures retain existing GitHub rules; no guidance-only success fallback.
 */
export async function syncMergePolicy(target, { request = createGitHubRequest(), current, signal } = {}) {
  if (!hash.test(target?.projectId) || !hash.test(target.policyKey) || !isGithubRepositoryUrl(target.repository)
    || !['existing', 'selected_people'].includes(target.mode) || !accountId(target.ownerGithubId) || !Array.isArray(target.allowedGithubIds) || target.allowedGithubIds.length > 1100 || target.allowedGithubIds.some(id => !accountId(id)) || new Set(target.allowedGithubIds).size !== target.allowedGithubIds.length
    || target.mode === 'selected_people' && !target.allowedGithubIds.includes(target.ownerGithubId) || typeof current !== 'function') throw fail('invalid_merge_target');
  const root = `repos/${new URL(githubRepositoryUrl(target.repository)).pathname.slice(1)}`;
  const api = async (path, options) => {
    const result = await request(path, { signal, ...options });
    if (result.status !== 'ok') throw fail(result.status === 'forbidden' ? 'github_permissions' : 'github_unavailable');
    return result;
  };
  const fresh = async () => {
    const latest = await current();
    if (latest?.policyKey !== target.policyKey || latest.repository !== target.repository) throw fail('policy_changed');
    signal?.throwIfAborted();
  };
  const list = async () => {
    const all = [];
    for (let page = 1; page <= 10; page++) {
      const result = await api(`${root}/rulesets?includes_parents=false&per_page=100&page=${page}`);
      if (!Array.isArray(result.body)) throw fail('verification_failed');
      all.push(...result.body);
      if (!result.more) return all;
    }
    throw fail('verification_failed');
  };
  try {
    const user = (await api('user')).body;
    if (user?.id !== target.ownerGithubId) throw fail('account_mismatch');
    const repo = (await api(root)).body;
    if (repo?.permissions?.admin !== true) throw fail('github_permissions');
    const rows = await list();
    // Two projects cannot silently impose incompatible merge allowlists on one repository.
    if (rows.some(row => row.name?.startsWith('MyLittleSwarm merge access ') && row.name !== nameFor(target))) throw fail('conflicting_rulesets');
    const owned = rows.filter(row => row.name === nameFor(target));
    if (owned.length > 1 || owned.some(row => !accountId(row.id) || row.source_type !== 'Repository')) throw fail('conflicting_rulesets');
    const existing = owned[0], path = existing ? `${root}/rulesets/${existing.id}` : `${root}/rulesets`;
    if (target.mode === 'existing') {
      if (existing) { await fresh(); await api(path, { method: 'DELETE' }); }
      if ((await list()).some(row => row.name === nameFor(target))) throw fail('verification_failed');
      await fresh();
      return { projectId: target.projectId, policyKey: target.policyKey, code: 'removed' };
    }
    // Requiring PR-only creation before the initial commit would strand an empty repository.
    if (typeof repo.default_branch !== 'string' || !repo.default_branch) throw fail('empty_repository');
    const branch = await request(`${root}/branches/${encodeURIComponent(repo.default_branch)}`, { signal });
    if (branch.status === 'unavailable') throw fail('empty_repository');
    if (branch.status !== 'ok' || branch.body?.name !== repo.default_branch) throw fail('github_unavailable');
    const expected = mergeAccessRuleset(target);
    const actual = existing ? (await api(path)).body : null;
    if (!matches(actual, expected)) {
      await fresh();
      const saved = (await api(path, { method: existing ? 'PUT' : 'POST', body: expected })).body;
      if (!accountId(saved?.id)) throw fail('verification_failed');
      const verified = (await api(`${root}/rulesets/${saved.id}`)).body;
      if (!matches(verified, expected)) throw fail('verification_failed');
    }
    // A lost create reply or concurrent owner computer must not leave duplicate rulesets unnoticed.
    if ((await list()).filter(row => row.name === nameFor(target)).length !== 1) throw fail('conflicting_rulesets');
    await fresh();
    return { projectId: target.projectId, policyKey: target.policyKey, code: 'verified' };
  } catch (error) {
    if (signal?.aborted || error?.code === 'policy_changed') throw error;
    return { projectId: target.projectId, policyKey: target.policyKey, code: ['github_permissions', 'github_unavailable', 'account_mismatch', 'verification_failed', 'conflicting_rulesets', 'empty_repository'].includes(error?.code) ? error.code : 'github_unavailable' };
  }
}

export async function syncMergePolicies(value, { ownerClient, options, signal, sync = syncMergePolicy }) {
  for (const target of value.mergePolicies ?? []) {
    try {
      const report = await sync(target, { signal, current: async () => (await ownerClient.listRepositoryAccess(options(signal))).mergePolicies?.find(row => row.projectId === target.projectId) });
      await ownerClient.reportMergePolicy(report, options(signal));
    } catch (error) { if (signal?.aborted) throw error; /* Current intent is retried next cadence. */ }
  }
}
