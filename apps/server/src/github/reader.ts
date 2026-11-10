// One central read-only client. Credentials never enter persisted state or diagnostics.
import { z } from 'zod';
import { RESOURCES, type GitHubResource } from './context.js';
import { githubNumberIdentity } from './resource-identity.js';
type ReadFailureCode = 'rate_limited' | 'unavailable' | 'access_denied' | 'repository_changed' | 'invalid_response' | 'response_too_large';
export class GitHubReadFailure extends Error {
  constructor(public code: ReadFailureCode, public retryAt: number | null = null, public requests = 0, public bytes = 0) { super(code); }
}
type RepositoryPageRequest = { resource: GitHubResource; repoUrl: string; repositoryId: number; page: number; since: number | null };
export type RepositoryPage = { items: unknown[]; hasNext: boolean; sourceAt: number | null; deferUntil: number | null; requests: number; bytes: number };
export type ReadRepositoryPage = (request: RepositoryPageRequest) => Promise<RepositoryPage>;
export const GITHUB_PAGE_SIZE = 20;
const MAX_BYTES = 2 * 1024 * 1024;
function defer(headers: Headers, at: number) {
  const seconds = Number(headers.get('retry-after')), retryAt = at + seconds * 1000;
  const retry = headers.has('retry-after') && seconds >= 0 && Number.isSafeInteger(retryAt) ? retryAt : null;
  const reset = Number(headers.get('x-ratelimit-reset')) * 1000;
  const primary = headers.get('x-ratelimit-remaining') === '0'
    ? headers.has('x-ratelimit-reset') && Number.isSafeInteger(reset) && reset > at ? reset : at + 60000 : null;
  return retry === null && primary === null ? null : Math.max(at + 1000, retry ?? 0, primary ?? 0);
}

export function githubRepositoryReader(token: string): ReadRepositoryPage {
  if (!token || /[\s\x00-\x1f]/.test(token)) throw new Error('A valid local GitHub read credential is required.');
  return async input => {
    const repoUrl = githubNumberIdentity(input.repoUrl, 1).repoUrl;
    if (!RESOURCES.includes(input.resource) || input.resource !== 'issues' && input.since !== null || !Number.isSafeInteger(input.page) || input.page < 1 || input.page > 1000000
      || !Number.isSafeInteger(input.repositoryId) || input.repositoryId < 1
      || input.since !== null && (!Number.isSafeInteger(input.since) || input.since < 0)) throw new Error('Invalid repository read context.');
    const path = new URL(repoUrl).pathname;
    let requests = 0, bytes = 0, deferUntil: number | null = null;
    async function read(url: URL) {
      if (deferUntil !== null && deferUntil > Date.now()) throw new GitHubReadFailure('rate_limited', deferUntil);
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 12000);
      try {
        requests++;
        const response = await fetch(url, { method: 'GET', redirect: 'manual', signal: controller.signal, headers: {
          authorization: `Bearer ${token}`, accept: 'application/vnd.github+json',
          'x-github-api-version': '2026-03-10', 'user-agent': 'agent-workspace-reconciler',
        } });
        deferUntil = defer(response.headers, Date.now());
        if (response.status === 429 || response.status === 403 && (deferUntil !== null || response.headers.has('retry-after'))) {
          await response.body?.cancel(); throw new GitHubReadFailure('rate_limited', deferUntil ?? Date.now() + 60000);
        }
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel(); throw new GitHubReadFailure('repository_changed');
        }
        if (response.status === 401 || response.status === 404) {
          await response.body?.cancel(); throw new GitHubReadFailure('access_denied');
        }
        if (![200, 403].includes(response.status) || !response.body) {
          await response.body?.cancel(); throw new GitHubReadFailure('unavailable');
        }
        const chunks: Uint8Array[] = [], reader = response.body.getReader();
        let size = 0;
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength; bytes += part.value.byteLength;
          if (size > (response.status === 403 ? 16 * 1024 : MAX_BYTES)) { await reader.cancel(); throw new GitHubReadFailure('response_too_large'); }
          chunks.push(part.value);
        }
        let value: unknown;
        try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { throw new GitHubReadFailure(response.status === 403 ? 'access_denied' : 'invalid_response'); }
        if (response.status === 403) {
          const message = value && typeof value === 'object' && 'message' in value ? String(value.message) : '';
          throw new GitHubReadFailure(/rate limit|abuse/i.test(message) ? 'rate_limited' : 'access_denied', /rate limit|abuse/i.test(message) ? Date.now() + 60000 : null);
        }
        return { value, headers: response.headers };
      } catch (error) {
        if (error instanceof GitHubReadFailure) throw error;
        throw new GitHubReadFailure('unavailable');
      } finally { clearTimeout(timer); }
    }
    try {
      // Verify immutable numeric identity before indexing content from a mutable owner/repo path.
      const repository = await read(new URL(`https://api.github.com/repos${path}`));
      const metadata = z.object({ id: z.number().int().positive(), full_name: z.string().max(300) }).safeParse(repository.value);
      if (!metadata.success || metadata.data.id !== input.repositoryId
        || githubNumberIdentity(`https://github.com/${metadata.data.full_name}`, 1).repoUrl !== repoUrl) throw new GitHubReadFailure('repository_changed');
      const endpoint = input.resource === 'pull_requests' ? 'pulls' : input.resource;
      const url = new URL(`https://api.github.com/repos${path}/${endpoint}`);
      url.search = new URLSearchParams({ state: 'all', sort: input.resource === 'milestones' ? 'due_on' : 'updated', direction: 'asc', per_page: String(GITHUB_PAGE_SIZE), page: String(input.page),
        ...(input.since === null ? {} : { since: new Date(input.since).toISOString() }) }).toString();
      const response = await read(url);
      if (!Array.isArray(response.value) || response.value.length > GITHUB_PAGE_SIZE) throw new GitHubReadFailure('invalid_response');
      // Do not follow supplied Link destinations with credentials. Only a next-page signal is used;
      // the next trusted API URL is rebuilt from the persisted repository/page context.
      const hasNext = /(?:^|,)\s*<[^>]+>\s*;\s*rel="next"/.test(response.headers.get('link') ?? '');
      const sourceDate = Date.parse(response.headers.get('date') ?? '');
      const sourceAt = Number.isSafeInteger(sourceDate) && sourceDate >= 0 ? sourceDate : null;
      return { items: response.value, hasNext, sourceAt, deferUntil, requests, bytes };
    } catch (error) {
      const failure = error instanceof GitHubReadFailure ? error : new GitHubReadFailure('invalid_response');
      failure.requests = requests; failure.bytes = bytes;
      throw failure;
    }
  };
}
