import { beforeEach, expect, test } from 'vitest';
import { inProject } from '../src/firestore.js';
import { syncState } from '../src/github/context.js';
import { GitHubReadFailure } from '../src/github/reader.js';
import { reconcileRepository, unblockRepository } from '../src/github/sync.js';
import { resetEmulator, seed, TEST_PROJECT } from './helpers.js';

beforeEach(resetEmulator);

test('a malformed GitHub reply is retried on the schedule before the repository is blocked', async () => {
  await seed();
  const malformed = async () => { throw new GitHubReadFailure('invalid_response'); };
  const attempt = () => reconcileRepository(TEST_PROJECT, 'issues', { repositoryId: 7 }, malformed);
  // Each retry waits for its scheduled time; clear it so the next attempt runs now.
  const due = () => inProject(TEST_PROJECT, () => syncState('issues').update({ readyAt: 0 }));
  expect(await attempt()).toMatchObject({ outcome: 'retry', failure: 'invalid_response' });
  await due();
  expect(await attempt()).toMatchObject({ outcome: 'retry', failure: 'invalid_response' });
  await due();
  expect(await attempt()).toMatchObject({ outcome: 'blocked', failure: 'invalid_response' });
  expect(await attempt()).toEqual({ outcome: 'blocked' });
});

test('only malformed replies in a row count toward blocking', async () => {
  await seed();
  const codes = ['invalid_response', 'unavailable', 'invalid_response', 'unavailable', 'invalid_response'] as const;
  const due = () => inProject(TEST_PROJECT, () => syncState('issues').update({ readyAt: 0 }));
  for (const code of codes) {
    expect(await reconcileRepository(TEST_PROJECT, 'issues', { repositoryId: 7 }, async () => { throw new GitHubReadFailure(code); }))
      .toMatchObject({ outcome: 'retry', failure: code });
    await due();
  }
});

test('access denied still blocks on the first failure', async () => {
  await seed();
  const denied = async () => { throw new GitHubReadFailure('access_denied'); };
  expect(await reconcileRepository(TEST_PROJECT, 'issues', { repositoryId: 7 }, denied)).toMatchObject({ outcome: 'blocked', failure: 'access_denied' });
});

test('an operator can unblock a repository so the next run reads it again', async () => {
  await seed();
  const binding = { repositoryId: 7 };
  expect(await unblockRepository(TEST_PROJECT, 'issues', binding)).toEqual({ outcome: 'not_blocked' });
  // A block left by the earlier rule: one malformed reply, no counter.
  await inProject(TEST_PROJECT, async () => {
    await reconcileRepository(TEST_PROJECT, 'issues', binding, async () => { throw new GitHubReadFailure('access_denied'); });
    await syncState('issues').update({ lastFailure: 'invalid_response', invalidResponses: null });
  });
  expect(await reconcileRepository(TEST_PROJECT, 'issues', binding, async () => { throw new Error('not read'); })).toEqual({ outcome: 'blocked' });
  expect(await unblockRepository(TEST_PROJECT, 'issues', { repositoryId: 8 })).toEqual({ outcome: 'not_blocked' });
  expect(await unblockRepository(TEST_PROJECT, 'issues', binding)).toEqual({ outcome: 'unblocked', lastFailure: 'invalid_response' });
  expect(await inProject(TEST_PROJECT, async () => (await syncState('issues').get()).data()))
    .toMatchObject({ blocked: false, consecutiveFailures: 0, lastFailure: null, invalidResponses: 0, leaseUntil: 0 });
  const malformed = async () => { throw new GitHubReadFailure('invalid_response'); };
  expect(await reconcileRepository(TEST_PROJECT, 'issues', binding, malformed)).toMatchObject({ outcome: 'retry', failure: 'invalid_response' });
});
