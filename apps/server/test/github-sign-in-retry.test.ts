// GitHub transport only: confirming an account reads GitHub and never writes anything.
import { afterEach, expect, test, vi } from 'vitest';
import { confirmGithubAccount, githubApiTransport } from '../src/github/sign-in.js';
import { Refusal } from '../src/errors.js';

afterEach(() => { vi.restoreAllMocks(); });
const confirm = () => confirmGithubAccount('synthetic-access');

test.each([
  [429, {}], [500, {}], [502, {}], [503, {}], [504, {}],
  [403, { 'retry-after': '3' }], [403, { 'x-ratelimit-remaining': '0' }],
] as const)('GitHub HTTP %s retryable failure is not a credential refusal', async (status, headers) => {
  vi.spyOn(githubApiTransport, 'fetch').mockImplementation(async () => new Response('{}', { status, headers }));
  const failure = await confirm().catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(failure).not.toBeInstanceOf(Refusal);
});

test('GitHub transport outage stays a server failure', async () => {
  vi.spyOn(githubApiTransport, 'fetch').mockRejectedValue(new Error('Synthetic network failure'));
  const failure = await confirm().catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(failure).not.toBeInstanceOf(Refusal);
});

test('a failed provider read still consumes the successful sibling response', async () => {
  const failed = new Response('{}', { status: 503 });
  const sibling = new Response(JSON.stringify([{ email: 'owner@example.test', verified: true, primary: true }]));
  vi.spyOn(githubApiTransport, 'fetch').mockImplementation(async url => url.endsWith('/user') ? failed : sibling);
  await expect(confirm()).rejects.toThrow();
  expect(failed.bodyUsed).toBe(true);
  expect(sibling.bodyUsed).toBe(true);
});

test.each([401, 403])('GitHub HTTP %s credential denial still refuses sign-in', async status => {
  vi.spyOn(githubApiTransport, 'fetch').mockImplementation(async () => new Response('{}', { status }));
  await expect(confirm())
    .rejects.toMatchObject({ code: 'unauthorized' });
});

test('confirmed GitHub identity is returned after successful provider reads', async () => {
  vi.spyOn(githubApiTransport, 'fetch').mockImplementation(async url => new Response(JSON.stringify(url.endsWith('/user')
    ? { id: 7, login: 'synthetic-owner' }
    : [{ email: 'owner@example.test', verified: true, primary: true }])));
  await expect(confirm())
    .resolves.toEqual({ githubId: '7', login: 'synthetic-owner', name: null, avatarUrl: null, emails: ['owner@example.test'] });
});
