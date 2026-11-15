import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalGithubRepo, githubRepositoryUrl, isGithubRepositoryUrl } from '../src/github-repository.mjs';

// The same cases as apps/server/test/github-repository.test.ts, which checks @minions/contracts.
const CASES = [
  ['https://github.com/Owner/Repo', 'https://github.com/Owner/Repo'],
  ['https://github.com/o/r.git', 'https://github.com/o/r'],
  ['https://github.com/o/r/', 'https://github.com/o/r'],
  ['https://github.com/o/r.git/', 'https://github.com/o/r'],
  ['https://github.com/o/.github', 'https://github.com/o/.github'],
  ['https://github.com/o/.git', null],
  ['https://github.com/o/..', null],
  ['https://github.com/o_x/r', 'https://github.com/o_x/r'],
  ['https://github.com/o/r.GIT', 'https://github.com/o/r'],
  ['https://github.com/_o/r', null],
  ['https://github.com/-o/r', null],
  ['https://github.com/o/r/pulls', null],
  ['http://github.com/o/r', null],
  ['https://github.com/o/r?x=1', null],
];

test('repository links read the same as the shared contract', () => {
  for (const [input, expected] of CASES) assert.equal(githubRepositoryUrl(input), expected, input);
  assert.equal(canonicalGithubRepo('https://github.com/Owner/Repo.git'), 'https://github.com/owner/repo');
  assert.equal(isGithubRepositoryUrl('https://github.com/o/r'), true);
  // Links saved before the shared reading may keep `.git` or `/`; they are still accepted.
  assert.equal(isGithubRepositoryUrl('https://github.com/o/r.git/'), true);
  assert.equal(isGithubRepositoryUrl('https://github.com/_o/r'), false);
});
