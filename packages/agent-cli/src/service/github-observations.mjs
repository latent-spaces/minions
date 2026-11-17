// Read-only github.com observations. Credentials and raw API responses never leave this computer.
import { execFile } from 'node:child_process';
import { repositoryEnvironment } from './repository-access.mjs';
import { githubRepositoryUrl, isGithubRepositoryUrl } from '../github-repository.mjs';

// JSON request bodies go through stdin, with no shell or temporary credential files.
const runWithInput = (command, args, { input, ...options }) => new Promise((resolve, reject) => {
  const child = execFile(command, args, options, (error, stdout, stderr) => error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr }));
  child.stdin.on('error', reject);
  child.stdin.end(input);
});
const login = value => typeof value === 'string' && /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(value) ? value : null;
const text = (value, max = 200) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value) ? value : null;
const fact = (status = 'not_checked', value = null) => ({ status, value });
const roles = ['admin', 'maintain', 'write', 'triage', 'read', 'none'];
async function inspectPullRequests(root, request, signal) {
  let open = 0, drafts = 0, merged = 0, complete = true;
  // Bound each scan; only aggregate counts leave the computer. Closed PRs
  // include unmerged proposals, so count only rows with a merge timestamp.
  for (const state of ['open', 'closed']) {
    const seen = new Map();
    for (let page = 1; page <= 5; page++) {
      const result = await request(`${root}/pulls?state=${state}&per_page=100&page=${page}`, { signal });
      if (result.status !== 'ok') return fact(result.status);
      if (!Array.isArray(result.body) || result.body.length > 100) throw new Error('Invalid PR list.');
      for (const row of result.body) {
        if (!Number.isSafeInteger(row?.number) || row.number < 1 || row.state !== state || typeof row.draft !== 'boolean') throw new Error('Invalid PR.');
        if (state === 'closed' && row.merged_at !== null && (typeof row.merged_at !== 'string' || !Number.isFinite(Date.parse(row.merged_at)))) throw new Error('Invalid merge timestamp.');
        seen.set(row.number, state === 'open' ? row.draft : row.merged_at !== null);
      }
      if (!result.more || page === 5) { complete &&= !result.more; break; }
    }
    const flagged = [...seen.values()].filter(Boolean).length;
    if (state === 'open') { open = seen.size; drafts = flagged; }
    else merged = flagged;
  }
  return fact('ok', { open, drafts, merged, complete });
}
const roleOf = value => roles.includes(value?.role_name) ? value.role_name : ['admin', 'maintain', 'push', 'triage', 'pull'].find(key => value?.permissions?.[key])?.replace('push', 'write').replace('pull', 'read') ?? null;
function checks(value) {
  if (!Array.isArray(value)) throw new Error('Invalid check list.');
  const parsed = value.map(item => text(item?.context));
  return { values: [...new Set(parsed.filter(Boolean))].slice(0, 100), complete: value.length <= 100 && parsed.every(Boolean) };
}

export function createGitHubRequest({ execute = runWithInput, envSource = process.env } = {}) {
  // Keep platform credential locations, including Windows gh configuration. No shell is involved.
  const env = repositoryEnvironment(envSource);
  return async (path, { signal, method = 'GET', body } = {}) => {
    let output, error;
    // A page of 100 PRs includes bodies and nested repository/user records and
    // can exceed the subprocess buffer. Project inside gh before stdout reaches
    // Node; keep the existing bound and HTTP/Link headers for status and paging.
    const projection = /^repos\/[^/]+\/[^/]+\/pulls\?/.test(path) ? ['--jq', 'map({number, state, draft, merged_at})'] : [];
    try { output = await execute('gh', ['api', '--hostname', 'github.com', '--method', method, '--include', '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2026-03-10', path, ...projection, ...(body === undefined ? [] : ['--input', '-'])], { ...(body === undefined ? {} : { input: JSON.stringify(body) }), env, signal, encoding: 'utf8', timeout: 10000, maxBuffer: 1048576, windowsHide: true }); }
    catch (caught) { error = caught; output = caught; }
    if (signal?.aborted) throw signal.reason;
    if (error?.code === 'ENOENT') return { status: 'missing' };
    const raw = typeof output?.stdout === 'string' ? output.stdout : '';
    const match = /^HTTP\/[\d.]+\s+(\d{3})[^\r\n]*\r?\n([\s\S]*?)\r?\n\r?\n([\s\S]*)$/.exec(raw);
    if (!match) return { status: error && /(?:gh auth login|GH_TOKEN environment variable|not logged into)/i.test(String(error.stderr ?? '')) ? 'signed_out' : 'failed' };
    const code = Number(match[1]), headers = match[2];
    if (code === 401) return { status: 'signed_out' };
    if (code === 429 || code === 403 && (/(?:x-ratelimit-remaining:\s*0\b|retry-after:)/i.test(headers) || /rate limit/i.test(match[3]))) return { status: 'rate_limited' };
    if (code === 403) return { status: 'forbidden' };
    if (code === 404) return { status: 'unavailable' };
    if (code < 200 || code >= 300 || error) return { status: 'failed' };
    try { return { status: 'ok', body: code === 204 ? null : JSON.parse(match[3]), more: /link:.*rel="next"/i.test(headers) }; }
    catch { return { status: 'failed' }; }
  };
}

export async function inspectGitHubAccess(target, { request = createGitHubRequest(), signal, now = Date.now } = {}) {
  if (!/^[a-f0-9]{64}$/.test(target?.projectId) || !Number.isSafeInteger(target.membershipEpoch) || target.membershipEpoch < 0 || !['self', 'project'].includes(target.scope) || !isGithubRepositoryUrl(target.repository)) throw new Error('Invalid GitHub observation target.');
  const report = { version: 1, projectId: target.projectId, repository: target.repository, membershipEpoch: target.membershipEpoch, checkedAt: now(), account: fact(), access: fact(), collaborators: fact(), invitations: fact(), rules: fact(), protection: fact(), pullRequests: fact() };
  const read = async (path, parse) => {
    try { const result = await request(path, { signal }); return result.status === 'ok' ? fact('ok', parse(result.body, result.more)) : fact(result.status); }
    catch (error) { if (signal?.aborted) throw error; return fact('failed'); }
  };
  const root = `repos/${new URL(githubRepositoryUrl(target.repository)).pathname.slice(1)}`;
  report.account = await read('user', body => { const name = login(body?.login); if (!name) throw new Error(); return { login: name }; });
  if (report.account.status !== 'ok') { report.access = fact(report.account.status); return report; }
  report.access = await read(root, body => { const branch = text(body?.default_branch); if (!branch) throw new Error(); return { role: roleOf(body), defaultBranch: branch }; });
  if (target.scope === 'self') return report;
  const list = (body, more, parse) => { if (!Array.isArray(body)) throw new Error(); const people = body.slice(0, 100).map(parse); return { people, complete: !more && body.length < 100 }; };
  [report.collaborators, report.invitations] = await Promise.all([
    read(`${root}/collaborators?per_page=100`, (body, more) => list(body, more, row => { const name = login(row?.login); if (!name) throw new Error(); return { login: name, role: text(row?.role_name) ?? roleOf(row) ?? 'unknown' }; })),
    read(`${root}/invitations?per_page=100`, (body, more) => list(body, more, row => { const name = login(row?.invitee?.login); if (!name) throw new Error(); return { login: name, invitedBy: login(row?.inviter?.login) }; })),
  ]);
  if (report.access.status !== 'ok') return report;
  try { report.pullRequests = await inspectPullRequests(root, request, signal); }
  catch (error) { if (signal?.aborted) throw error; report.pullRequests = fact('failed'); }
  const branch = encodeURIComponent(report.access.value.defaultBranch);
  [report.rules, report.protection] = await Promise.all([
    read(`${root}/rules/branches/${branch}?per_page=100`, (body, more) => {
      if (!Array.isArray(body)) throw new Error(); const rules = body.slice(0, 100);
      const types = [...new Set(rules.map(row => text(row?.type, 100)))]; if (types.includes(null)) throw new Error();
      const approvals = rules.filter(row => row.type === 'pull_request').map(row => row.parameters?.required_approving_review_count).filter(value => Number.isInteger(value) && value >= 0 && value <= 100);
      const requiredChecks = checks(rules.flatMap(row => row.parameters?.required_status_checks ?? []));
      return { types, requiredApprovals: approvals.length ? Math.max(...approvals) : null, requiredChecks: requiredChecks.values, complete: !more && body.length < 100 && requiredChecks.complete };
    }),
    read(`${root}/branches/${branch}/protection`, body => {
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
      const count = body.required_pull_request_reviews?.required_approving_review_count;
      const requiredChecks = checks(body.required_status_checks?.checks ?? (body.required_status_checks?.contexts ?? []).map(context => ({ context })));
      if (!requiredChecks.complete) throw new Error('Incomplete protection checks.');
      return { requiredApprovals: Number.isInteger(count) && count >= 0 && count <= 100 ? count : null, requiredChecks: requiredChecks.values, pullRequests: !!body.required_pull_request_reviews, enforceAdmins: body.enforce_admins?.enabled === true };
    }),
  ]);
  return report;
}

export function createGitHubAccessObserver({ ownerClient, principal, inspect = inspectGitHubAccess, intervalMs = 300000, timeoutMs = 120000 }) {
  const abort = new AbortController(); let pending, closed = false, offset = 0;
  const options = signal => ({ signal, expectedProfileId: principal.ownerId });
  function poll() {
    if (closed) return Promise.resolve();
    return pending ??= (async () => {
      const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(timeoutMs)]);
      const value = await ownerClient.listRepositoryAccess(options(signal));
      const available = Array.isArray(value.observations) ? value.observations.slice(0, 100) : [];
      const targets = available.length ? Array.from({ length: Math.min(20, available.length) }, (_, index) => available[(offset + index) % available.length]) : [];
      offset = available.length ? (offset + targets.length) % available.length : 0;
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(2, targets.length) }, async () => {
        while (next < targets.length && !signal.aborted) {
          const target = targets[next++];
          try { const report = await inspect(target, { signal }); if (!signal.aborted) await ownerClient.reportRepositoryAccess(report, options(signal)); } catch { /* Next cadence retries; no raw errors are reported. */ }
        }
      }));
    })().catch(() => {}).finally(() => { pending = null; });
  }
  const timer = setInterval(() => { void poll(); }, intervalMs); timer.unref?.(); void poll();
  return { poll, async close() { closed = true; clearInterval(timer); abort.abort(); await pending; } };
}
