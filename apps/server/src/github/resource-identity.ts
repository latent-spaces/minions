// Canonical identity of a numbered GitHub resource (pull request or Issue observation) in the
// project's repository. The key hash is unchanged from earlier observation records.
import { createHash } from 'node:crypto';
import { canonicalGithubRepo } from '@mlswarm/contracts';
import { Refusal } from '../errors.js';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export function githubNumberIdentity(repoUrl: string, number: number) {
  if (!Number.isSafeInteger(number) || number < 1) throw new Refusal('bad_input', 'A GitHub number must be a positive integer.');
  if (!repoUrl) throw new Refusal('bad_input', 'This project has no GitHub repository yet. Ask the owner to add one in Settings.');
  const canonical = canonicalGithubRepo(repoUrl);
  if (!canonical) throw new Refusal('bad_input', 'The project’s repository must be a GitHub link like https://github.com/owner/repo. Ask the owner to fix it in Settings.');
  return { key: hash(`${canonical}#${number}`), repoUrl: canonical };
}
