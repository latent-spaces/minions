import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitHubRequest, inspectGitHubAccess, createGitHubAccessObserver } from '../src/service/github-observations.mjs';

const target = { projectId: 'a'.repeat(64), repository: 'https://github.com/example/project', scope: 'project', membershipEpoch: 4 };
const ok = (body, more = false) => ({ status: 'ok', body, more });
function fixture(overrides = {}) {
  const requests = [];
  const values = { user: ok({ login: 'actual-worker' }), 'repos/example/project': ok({ default_branch: 'feature/main', permissions: { push: true } }),
    'repos/example/project/pulls?state=open&per_page=100&page=1': ok([]),
    'repos/example/project/pulls?state=closed&per_page=100&page=1': ok([]),
    'repos/example/project/collaborators?per_page=100': ok([{ login: 'collaborator', role_name: 'maintain', email: 'private' }]),
    'repos/example/project/invitations?per_page=100': ok([{ invitee: { login: 'invited' }, inviter: { login: 'admin' }, token: 'private' }]),
    'repos/example/project/rules/branches/feature%2Fmain?per_page=100': ok([{ type: 'pull_request', parameters: { required_approving_review_count: 2 } }, { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'build' }] } }]),
    'repos/example/project/branches/feature%2Fmain/protection': ok({ required_pull_request_reviews: { required_approving_review_count: 1 }, required_status_checks: { contexts: ['test'] }, enforce_admins: { enabled: true } }), ...overrides };
  return { requests, request: async path => { requests.push(path); assert.ok(path in values, path); return values[path]; } };
}
test('read-only project inspection reports actual login, bounded sanitized access and branch requirements', async () => {
  const f = fixture(), report = await inspectGitHubAccess(target, { request: f.request, now: () => 123 });
  assert.equal(report.checkedAt, 123); assert.equal(report.membershipEpoch, 4);
  assert.deepEqual(report.account, { status: 'ok', value: { login: 'actual-worker' } });
  assert.deepEqual(report.access.value, { role: 'write', defaultBranch: 'feature/main' });
  assert.deepEqual(report.collaborators.value, { people: [{ login: 'collaborator', role: 'maintain' }], complete: true });
  assert.deepEqual(report.invitations.value, { people: [{ login: 'invited', invitedBy: 'admin' }], complete: true });
  assert.deepEqual(report.rules.value, { types: ['pull_request', 'required_status_checks'], requiredApprovals: 2, requiredChecks: ['build'], complete: true });
  assert.deepEqual(report.protection.value, { requiredApprovals: 1, requiredChecks: ['test'], pullRequests: true, enforceAdmins: true });
  assert.equal(JSON.stringify(report).includes('private'), false); assert.equal(f.requests.length, 8);
});
test('a stored link with `.git` or `/` reads the same repository', async () => {
  for (const repository of ['https://github.com/example/project.git', 'https://github.com/example/project/']) {
    const f = fixture(), report = await inspectGitHubAccess({ ...target, repository }, { request: f.request });
    assert.equal(report.access.status, 'ok'); assert.equal(f.requests[1], 'repos/example/project');
  }
});
test('self inspection collects only its account and access, with no presumed administrative facts', async () => {
  const f = fixture(), report = await inspectGitHubAccess({ ...target, scope: 'self' }, { request: f.request });
  assert.equal(f.requests.length, 2);
  for (const key of ['collaborators', 'invitations', 'rules', 'protection']) assert.deepEqual(report[key], { status: 'not_checked', value: null });
});
test('partial and unavailable responses never claim empty rules or no repository access', async () => {
  const f = fixture({ 'repos/example/project/collaborators?per_page=100': { status: 'forbidden' },
    'repos/example/project/invitations?per_page=100': { status: 'rate_limited' },
    'repos/example/project/rules/branches/feature%2Fmain?per_page=100': { status: 'unavailable' },
    'repos/example/project/branches/feature%2Fmain/protection': { status: 'unavailable' } });
  const report = await inspectGitHubAccess(target, { request: f.request });
  assert.equal(report.access.status, 'ok');
  for (const key of ['rules', 'protection']) assert.deepEqual(report[key], { status: 'unavailable', value: null });
  assert.equal(report.invitations.status, 'rate_limited'); assert.equal(report.collaborators.status, 'forbidden');
});
test('bounded single-page responses signal truncation and keep at most 100 entries', async () => {
  const f = fixture({ 'repos/example/project/collaborators?per_page=100': ok(Array.from({ length: 101 }, (_, i) => ({ login: `person-${i}`, role_name: 'read' })), true),
    'repos/example/project/rules/branches/feature%2Fmain?per_page=100': ok([{ type: 'required_status_checks', parameters: { required_status_checks: Array.from({ length: 101 }, (_, i) => ({ context: `job-${i}` })) } }]) });
  const report = await inspectGitHubAccess(target, { request: f.request });
  assert.equal(report.collaborators.value.people.length, 100); assert.equal(report.collaborators.value.complete, false);
  assert.equal(report.rules.value.requiredChecks.length, 100); assert.equal(report.rules.value.complete, false);
});
test('unsupported check contexts mark rules incomplete and fail protection instead of silently claiming completeness', async () => {
  for (const contexts of [[{ context: 'a'.repeat(201) }], [{ context: 'invalid\nname' }], [{ context: '' }], [{ unexpected: 'missing-context' }], Array.from({ length: 101 }, (_, i) => ({ context: `check-${i}` }))]) {
    const f = fixture({
      'repos/example/project/rules/branches/feature%2Fmain?per_page=100': ok([{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'valid-check' }, ...contexts] } }]),
      'repos/example/project/branches/feature%2Fmain/protection': ok({ required_status_checks: { checks: contexts } }),
    });
    const report = await inspectGitHubAccess(target, { request: f.request });
    assert.equal(report.rules.status, 'ok'); assert.equal(report.rules.value.complete, false);
    assert.ok(report.rules.value.requiredChecks.includes('valid-check'));
    assert.deepEqual(report.protection, { status: 'failed', value: null });
  }
});
test('missing or signed-out account stops repository inspection and does not leak errors', async () => {
  for (const status of ['missing', 'signed_out', 'failed']) {
    const f = fixture({ user: { status } }), report = await inspectGitHubAccess(target, { request: f.request });
    assert.deepEqual(f.requests, ['user']); assert.deepEqual(report.access, { status, value: null });
    assert.equal(report.rules.status, 'not_checked');
  }
  const f = fixture({ user: ok({ login: 'invalid\nsecret' }) });
  assert.equal((await inspectGitHubAccess(target, { request: f.request })).account.status, 'failed');
});
test('gh invocation forces github.com GET without a shell and preserves Windows/config credentials locally', async () => {
  const envSource = { PATH: 'tools', HOME: 'home', GH_CONFIG_DIR: 'C:\\profile with spaces\\gh', XDG_CONFIG_HOME: 'config', APPDATA: 'appdata', USERPROFILE: 'profile', SystemRoot: 'C:\\Windows', GH_TOKEN: 'local-secret', UNRELATED_SECRET: 'exclude', GH_HOST: 'other.example' };
  let call;
  const request = createGitHubRequest({ envSource, execute: async (...args) => { call = args; return { stdout: 'HTTP/2.0 200 OK\r\nLink: <next>; rel="next"\r\n\r\n[{"login":"person"}]' }; } });
  assert.deepEqual(await request('user'), { status: 'ok', body: [{ login: 'person' }], more: true });
  assert.equal(call[0], 'gh'); assert.deepEqual(call[1].slice(0, 6), ['api', '--hostname', 'github.com', '--method', 'GET', '--include']);
  assert.ok(call[1].includes('X-GitHub-Api-Version: 2026-03-10'));
  assert.equal(call[2].windowsHide, true); assert.equal(call[2].shell, undefined); assert.equal(call[2].timeout, 10000);
  for (const key of ['GH_CONFIG_DIR', 'XDG_CONFIG_HOME', 'APPDATA', 'USERPROFILE', 'SystemRoot', 'GH_TOKEN']) assert.equal(call[2].env[key], envSource[key]);
  assert.equal(call[2].env.UNRELATED_SECRET, undefined); assert.equal(call[2].env.GH_HOST, undefined);
});
test('plain Windows environment sources preserve credential and executable lookup keys regardless of case', async () => {
  let environment;
  const request = createGitHubRequest({ envSource: { Path: 'C:\\tools', PaThExT: '.EXE;.CMD', systemroot: 'C:\\Windows', appdata: 'roaming', userprofile: 'person', gh_config_dir: 'gh-config', xdg_config_home: 'xdg-config' },
    execute: async (_command, _args, options) => { environment = options.env; return { stdout: 'HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n\r\n{}' }; } });
  await request('user');
  assert.deepEqual(environment, { PATH: 'C:\\tools', PATHEXT: '.EXE;.CMD', SystemRoot: 'C:\\Windows', APPDATA: 'roaming', USERPROFILE: 'person', GH_CONFIG_DIR: 'gh-config', XDG_CONFIG_HOME: 'xdg-config', GH_PROMPT_DISABLED: '1', LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' });
});
test('large PR pages are projected before the bounded subprocess output, retaining pagination', async () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ number: i + 1, state: 'closed', draft: false,
    merged_at: i % 2 ? null : '2026-10-25T00:00:00Z', body: 'private content'.repeat(2000) }));
  const raw = JSON.stringify(rows);
  assert.ok(Buffer.byteLength(raw) > 1048576);
  const request = createGitHubRequest({ execute: async (command, args, options) => {
    assert.equal(command, 'gh');
    assert.equal(options.maxBuffer, 1048576);
    assert.equal(options.shell, undefined);
    // Model gh's documented --jq projection at the subprocess boundary: without
    // it this real-size fixture overflows before the observer can parse any PRs.
    const jq = args.indexOf('--jq');
    const body = jq < 0 ? raw : JSON.stringify(rows.map(({ number, state, draft, merged_at }) => ({ number, state, draft, merged_at })));
    if (Buffer.byteLength(body) > options.maxBuffer) throw { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' };
    assert.equal(args[jq + 1], 'map({number, state, draft, merged_at})');
    return { stdout: `HTTP/2.0 200 OK\r\nLink: <next>; rel="next"\r\n\r\n${body}` };
  } });
  const result = await request('repos/example/project/pulls?state=closed&per_page=100&page=1');
  assert.equal(result.status, 'ok'); assert.equal(result.more, true);
  assert.equal(result.body.length, 100);
  assert.equal(result.body.filter(row => row.merged_at !== null).length, 50);
  assert.equal(JSON.stringify(result).includes('private content'), false);
});
test('HTTP failures, missing executable and unauthenticated gh are sanitized into explicit statuses', async () => {
  for (const [header, expected, body = '{}'] of [ ['401 Unauthorized', 'signed_out'], ['403 Forbidden', 'forbidden'], ['403 Forbidden\r\nX-RateLimit-Remaining: 0', 'rate_limited'], ['429 Too Many Requests', 'rate_limited'], ['404 Not Found', 'unavailable'], ['500 Error', 'failed'], ['403 Forbidden', 'rate_limited', '{"message":"secondary rate limit"}'] ]) {
    const request = createGitHubRequest({ execute: async () => { throw { stdout: `HTTP/2.0 ${header}\r\nContent-Type: application/json\r\n\r\n${body}`, stderr: 'secret' }; } });
    assert.deepEqual(await request('user'), { status: expected });
  }
  for (const [error, expected] of [[{ code: 'ENOENT' }, 'missing'], [{ stderr: 'please run: gh auth login' }, 'signed_out'], [{ stdout: 'secret', stderr: 'private failure' }, 'failed']]) {
    const request = createGitHubRequest({ execute: async () => { throw error; } }); assert.deepEqual(await request('user'), { status: expected });
  }
});
test('invalid targets and cancellation stop observation without reporting guessed facts', async () => {
  for (const change of [{ repository: 'https://evil.example/a/b' }, { repository: 'https://github.com/../repo' }, { membershipEpoch: -1 }, { scope: 'unknown' }]) await assert.rejects(inspectGitHubAccess({ ...target, ...change }));
  const abort = new AbortController(); abort.abort();
  const request = createGitHubRequest({ execute: async () => { throw new Error('secret'); } });
  await assert.rejects(inspectGitHubAccess(target, { signal: abort.signal, request }));
});
test('background observer starts asynchronously, bounds concurrency and reports exact target epochs', async () => {
  const reports = []; let running = 0, maximum = 0, resolveFirst;
  const first = new Promise(resolve => { resolveFirst = resolve; });
  const ownerClient = { async listRepositoryAccess(options) { assert.equal(options.expectedProfileId, 'person'); return { owned: [], joined: [], observations: Array.from({ length: 25 }, () => target) }; }, async reportRepositoryAccess(report) { reports.push(report); } };
  const observer = createGitHubAccessObserver({ ownerClient, principal: { ownerId: 'person' }, intervalMs: 600000,
    inspect: async value => { running++; maximum = Math.max(maximum, running); await first; running--; return { membershipEpoch: value.membershipEpoch }; } });
  assert.equal(reports.length, 0); resolveFirst(); await observer.poll(); await observer.close();
  assert.equal(maximum, 2); assert.equal(reports.length, 20); assert.ok(reports.every(report => report.membershipEpoch === 4));
});
test('observer close cancels pending reads and does not report after cancellation', async () => {
  let cancelled = false, reports = 0;
  const ownerClient = { async listRepositoryAccess() { return { observations: [target] }; }, async reportRepositoryAccess() { reports++; } };
  const observer = createGitHubAccessObserver({ ownerClient, principal: { ownerId: 'person' }, intervalMs: 600000,
    inspect: async (_target, { signal }) => new Promise((resolve, reject) => { signal.addEventListener('abort', () => { cancelled = true; reject(signal.reason); }, { once: true }); }) });
  await new Promise(resolve => setImmediate(resolve)); await observer.close();
  assert.equal(cancelled, true); assert.equal(reports, 0); await observer.poll();
});
test('bounded observer rotates through a larger project list rather than starving later projects', async () => {
  const seen = [];
  const targets = Array.from({ length: 25 }, (_, index) => ({ ...target, projectId: index.toString(16).padStart(64, '0') }));
  const ownerClient = { async listRepositoryAccess() { return { observations: targets }; }, async reportRepositoryAccess(report) { seen.push(report.projectId); } };
  const observer = createGitHubAccessObserver({ ownerClient, principal: { ownerId: 'person' }, intervalMs: 600000, inspect: async value => value });
  await observer.poll(); assert.equal(seen.length, 20); await observer.poll(); await observer.close();
  assert.equal(new Set(seen).size, 25);
});
test('PR counts paginate, deduplicate moving pages and never transmit private PR content', async () => {
  const f = fixture({
    'repos/example/project/pulls?state=open&per_page=100&page=1': ok([{ number: 1, state: 'open', draft: true, title: 'private title', body: 'secret' }], true),
    'repos/example/project/pulls?state=open&per_page=100&page=2': ok([{ number: 1, state: 'open', draft: true }, { number: 2, state: 'open', draft: false }]),
  });
  const report = await inspectGitHubAccess(target, { request: f.request });
  assert.deepEqual(report.pullRequests, { status: 'ok', value: { open: 2, drafts: 1, merged: 0, complete: true } });
  assert.equal(JSON.stringify(report).includes('private title'), false);
  assert.equal(JSON.stringify(report).includes('secret'), false);
});
test('PR scans stop at five pages and distinguish zero, truncation and failures', async () => {
  const values = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [
    `repos/example/project/pulls?state=open&per_page=100&page=${i+1}`, ok([{ number: i+1, state: 'open', draft: true }], true),
  ]));
  const f = fixture(values);
  assert.deepEqual((await inspectGitHubAccess(target, { request: f.request })).pullRequests.value, { open: 5, drafts: 5, merged: 0, complete: false });
  assert.deepEqual((await inspectGitHubAccess(target, { request: fixture().request })).pullRequests.value, { open: 0, drafts: 0, merged: 0, complete: true });
  for (const result of [{ status: 'forbidden' }, { status: 'rate_limited' }, ok([{ number: 1, state: 'closed', draft: false }]), ok([{ number: 1, state: 'open' }])]) {
    const f = fixture({ 'repos/example/project/pulls?state=open&per_page=100&page=1': result });
    const report = await inspectGitHubAccess(target, { request: f.request });
    assert.equal(report.pullRequests.value, null);
    assert.equal(report.pullRequests.status, result.status === 'ok' ? 'failed' : result.status);
  }
});
test('members and inaccessible repositories never trigger a PR scan', async () => {
  for (const [scope, access] of [['self', ok({ default_branch: 'main' })], ['project', { status: 'unavailable' }]]) {
    const f = fixture({ 'repos/example/project': access });
    const report = await inspectGitHubAccess({ ...target, scope }, { request: f.request });
    assert.deepEqual(report.pullRequests, { status: 'not_checked', value: null });
    assert.equal(f.requests.some(path => path.includes('/pulls?')), false);
  }
});

test('merged counts exclude unmerged closures, deduplicate pages and preserve coverage', async () => {
  const row = number => ({ number, state: 'closed', draft: false, merged_at: '2026-10-25T00:00:00Z' });
  const f = fixture({
    'repos/example/project/pulls?state=closed&per_page=100&page=1': ok([row(1), { ...row(2), merged_at: null }], true),
    'repos/example/project/pulls?state=closed&per_page=100&page=2': ok([row(1), row(3)]),
  });
  assert.deepEqual((await inspectGitHubAccess(target, { request: f.request })).pullRequests.value, { open: 0, drafts: 0, merged: 2, complete: true });
  const pages = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [
    `repos/example/project/pulls?state=closed&per_page=100&page=${i+1}`, ok([row(i+1)], true),
  ]));
  assert.deepEqual((await inspectGitHubAccess(target, { request: fixture(pages).request })).pullRequests.value, { open: 0, drafts: 0, merged: 5, complete: false });
  for (const result of [{ status: 'rate_limited' }, ok([{ ...row(1), merged_at: undefined }]), ok([{ ...row(1), merged_at: 'invalid' }])]) {
    const report = await inspectGitHubAccess(target, { request: fixture({ 'repos/example/project/pulls?state=closed&per_page=100&page=1': result }).request });
    assert.equal(report.pullRequests.value, null);
    assert.equal(report.pullRequests.status, result.status === 'ok' ? 'failed' : result.status);
  }
});

test('ruleset mutations send bounded JSON through stdin without a shell on Windows; DELETE accepts 204', async () => {
  const body = { name: 'Minions merge access', bypass_actors: [{ actor_type: 'User', actor_id: 12, bypass_mode: 'pull_request' }] };
  const request = createGitHubRequest({ envSource: { UserProfile: 'C:\\Users\\Person Name', Path: 'C:\\GitHub CLI', GH_TOKEN: 'private-token' }, execute: async (command, args, options) => {
    assert.equal(command, 'gh'); assert.equal(options.shell, undefined); assert.equal(options.windowsHide, true);
    assert.equal(args.includes('private-token'), false);
    assert.equal(options.env.USERPROFILE, 'C:\\Users\\Person Name');
    if (args[args.indexOf('--method') + 1] === 'DELETE') return { stdout: 'HTTP/2.0 204 No Content\r\nDate: today\r\n\r\n' };
    assert.equal(args[args.indexOf('--input') + 1], '-');
    assert.deepEqual(JSON.parse(options.input), body);
    assert.equal(args.includes(JSON.stringify(body)), false);
    return { stdout: 'HTTP/2.0 201 Created\r\nContent-Type: application/json\r\n\r\n{"id":42}' };
  } });
  assert.equal((await request('repos/owner/repo/rulesets', { method: 'POST', body })).body.id, 42);
  assert.deepEqual(await request('repos/owner/repo/rulesets/42', { method: 'DELETE' }), { status: 'ok', body: null, more: false });
});
