import { describe, expect, it } from 'vitest';
import { canonicalGithubRepo, githubRepositoryUrl } from '@minions/contracts';
import { CREATE_PRIVATE } from '../src/projects/private.js';
import { PROPOSAL_CONTENT, STORED_PROPOSAL_CONTENT } from '../src/community/content.js';

// The same cases as packages/agent-cli/test/github-repository.test.mjs, which checks the connector's mirror.
const CASES: [string, string | null][] = [
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

describe('GitHub repository links', () => {
  it('reads every link the same way as the connector', () => {
    for (const [input, expected] of CASES) expect(githubRepositoryUrl(input), input).toBe(expected);
    expect(canonicalGithubRepo('https://github.com/Owner/Repo.git')).toBe('https://github.com/owner/repo');
  });
  it('stores a new private project link without the optional `.git` or `/`', () => {
    const input = { client_request_id: '00000000-0000-4000-8000-000000000000', title: 'T', goal: 'G' };
    expect(CREATE_PRIVATE.parse({ ...input, githubUrl: 'https://github.com/o/r.git/' }).githubUrl).toBe('https://github.com/o/r');
    expect(CREATE_PRIVATE.safeParse({ ...input, githubUrl: 'https://github.com/_o/r' }).success).toBe(false);
  });
  it('still reads a link saved under the earlier rule, but refuses it in new content', () => {
    const content = { title: 'T', githubUrl: 'https://github.com/_o/r.git' };
    expect(STORED_PROPOSAL_CONTENT.parse(content).githubUrl).toBe('https://github.com/_o/r.git');
    expect(STORED_PROPOSAL_CONTENT.parse({ ...content, githubUrl: 'https://github.com/o/r.git/' }).githubUrl).toBe('https://github.com/o/r');
    expect(PROPOSAL_CONTENT.safeParse(content).success).toBe(false);
  });
});
