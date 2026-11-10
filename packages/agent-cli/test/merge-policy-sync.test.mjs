import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeAccessRuleset, syncMergePolicy, syncMergePolicies } from '../src/service/merge-policy-sync.mjs';

const target = () => ({ projectId: 'a'.repeat(64), repository: 'https://github.com/owner/repo', policyKey: 'b'.repeat(64), mode: 'selected_people', ownerGithubId: 1, allowedGithubIds: [1, 2, 3] });
function github({ saved, account = 1, admin = true, mutate, onWrite } = {}) {
  const calls = [], root = 'repos/owner/repo';
  let rules = saved ? structuredClone(saved) : null;
  const request = async (path, options = {}) => {
    calls.push({ path, ...options });
    if (path === 'user') return { status: 'ok', body: { id: account } };
    if (path === root) return { status: 'ok', body: { permissions: { admin }, default_branch: 'main' } };
    if (path === `${root}/branches/main`) return { status: 'ok', body: { name: 'main' } };
    if (path.startsWith(`${root}/rulesets?`)) return { status: 'ok', body: rules ? [{ id: 5, name: rules.name, source_type: 'Repository' }] : [], more: false };
    if (options.method) {
      onWrite?.(options);
      if (options.method === 'DELETE') { rules = null; return { status: 'ok', body: null }; }
      rules = { id: 5, ...structuredClone(options.body) };
      mutate?.(rules);
      return { status: 'ok', body: { id: 5 } };
    }
    if (path === `${root}/rulesets/5`) return { status: 'ok', body: rules };
    throw new Error(`Unexpected GitHub request: ${path}`);
  };
  return { request, calls, get rules() { return rules; } };
}
const sync = (value, api, extra = {}) => syncMergePolicy(value, { request: api.request, current: async () => value, ...extra });
test('selected IDs alone bypass updates through PRs; feature branches and existing review/check rules are untouched', async () => {
  const value = target(), api = github();
  assert.equal((await sync(value, api)).code, 'verified');
  assert.deepEqual(api.rules.bypass_actors, [1, 2, 3].map(actor_id => ({ actor_id, actor_type: 'User', bypass_mode: 'pull_request' })));
  assert.deepEqual(api.rules.conditions.ref_name.include, ['~DEFAULT_BRANCH', 'refs/heads/main']);
  assert.deepEqual(api.rules.rules.map(row => row.type), ['creation', 'update', 'deletion', 'non_fast_forward']);
  assert.equal(api.rules.rules.find(row => row.type === 'update').parameters.update_allows_fetch_and_merge, false);
  assert.equal(api.calls.filter(row => row.method).length, 1);
  assert.equal(api.calls.find(row => row.method).method, 'POST');
  assert.equal(api.calls.some(row => /collaborators|protection/.test(row.path)), false);
});
test('a stored link with `.git` updates the same repository', async () => {
  const value = { ...target(), repository: 'https://github.com/owner/repo.git' }, api = github();
  assert.equal((await sync(value, api)).code, 'verified');
});
test('verified rules are checked again without redundant writes', async () => {
  const value = target(), api = github({ saved: { id: 5, ...mergeAccessRuleset(value) } });
  assert.equal((await sync(value, api)).code, 'verified');
  assert.equal(api.calls.some(row => row.method), false);
});
test('revocation replaces only this managed allowlist', async () => {
  const value = target(), api = github({ saved: { id: 5, ...mergeAccessRuleset(value) } });
  value.allowedGithubIds = [1, 3];
  assert.equal((await sync(value, api)).code, 'verified');
  assert.equal(api.calls.find(row => row.method).method, 'PUT');
  assert.deepEqual(api.rules.bypass_actors.map(row => row.actor_id), [1, 3]);
});
test('GitHub account mismatch and missing administration never mutate repository rules', async () => {
  for (const [options, expected] of [[{ account: 10 }, 'account_mismatch'], [{ admin: false }, 'github_permissions']]) {
    const api = github(options);
    assert.equal((await sync(target(), api)).code, expected);
    assert.equal(api.calls.some(row => row.method), false);
  }
});
test('a stale cloud policy cannot mutate GitHub or report success', async () => {
  const value = target(), api = github();
  await assert.rejects(sync(value, api, { current: async () => ({ ...value, policyKey: 'c'.repeat(64) }) }), { code: 'policy_changed' });
  assert.equal(api.calls.some(row => row.method), false);
});
test('stale intent after a write cannot report the previous policy as enforced', async () => {
  const value = target(), api = github(); let reads = 0;
  await assert.rejects(sync(value, api, { current: async () => ++reads === 1 ? value : null }), { code: 'policy_changed' });
});
test('a permissive or incomplete GitHub readback is not verified', async () => {
  for (const mutate of [row => row.bypass_actors.push({ actor_id: 50, actor_type: 'User', bypass_mode: 'always' }), row => row.enforcement = 'disabled', row => row.conditions.ref_name.include = ['refs/heads/other'], row => row.rules = []]) {
    assert.equal((await sync(target(), github({ mutate }))).code, 'verification_failed');
  }
});
test('another project’s rules and duplicate managed rules cause a visible conflict', async () => {
  const api = github({ saved: { id: 5, ...mergeAccessRuleset({ ...target(), projectId: 'c'.repeat(64) }) } });
  assert.equal((await sync(target(), api)).code, 'conflicting_rulesets');
  assert.equal(api.calls.some(row => row.method), false);
  const duplicate = github(); const original = duplicate.request;
  duplicate.request = async (path, options) => path.includes('rulesets?') ? { status: 'ok', body: [1, 2].map(id => ({ id, name: mergeAccessRuleset(target()).name, source_type: 'Repository' })) } : original(path, options);
  assert.equal((await sync(target(), duplicate)).code, 'conflicting_rulesets');
});
test('turning the mode off removes only its managed rule and verifies absence', async () => {
  const value = { ...target(), mode: 'existing', allowedGithubIds: [] }, api = github({ saved: { id: 5, ...mergeAccessRuleset(target()) } });
  assert.equal((await sync(value, api)).code, 'removed');
  assert.equal(api.rules, null);
  assert.deepEqual(api.calls.filter(row => row.method).map(row => [row.method, row.path]), [['DELETE', 'repos/owner/repo/rulesets/5']]);
});
test('unsupported GitHub permissions never fall back to guidance-only success', async () => {
  const api = github(); const original = api.request;
  api.request = async (path, options) => options?.method ? { status: 'forbidden' } : original(path, options);
  assert.equal((await sync(target(), api)).code, 'github_permissions');
});

test('approved-computer synchronization refreshes intent and sends only sanitized receipts', async () => {
  const value = target(), reports = [], controller = new AbortController();
  const options = signal => ({ signal, expectedProfileId: 'owner' });
  const ownerClient = {
    async listRepositoryAccess(input) { assert.equal(input.expectedProfileId, 'owner'); return { mergePolicies: [value] }; },
    async reportMergePolicy(report, input) { assert.equal(input.expectedProfileId, 'owner'); reports.push(report); },
  };
  await syncMergePolicies({ mergePolicies: [value] }, { ownerClient, options, signal: controller.signal, sync: async (target, { current }) => {
    assert.equal(await current(), value);
    return { projectId: target.projectId, policyKey: target.policyKey, code: 'verified' };
  } });
  assert.deepEqual(reports, [{ projectId: value.projectId, policyKey: value.policyKey, code: 'verified' }]);
  await syncMergePolicies({}, { ownerClient, options, signal: controller.signal, sync: async () => assert.fail('no selected targets') });
});

test('empty repositories remain pending instead of blocking their initial commit', async () => {
  const api = github(), original = api.request;
  api.request = async (path, options) => path.endsWith('/branches/main') ? { status: 'unavailable' } : original(path, options);
  assert.equal((await sync(target(), api)).code, 'empty_repository');
  assert.equal(api.calls.some(row => row.method), false);
});
