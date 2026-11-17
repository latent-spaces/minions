// Mirrors packages/contracts/src/github-repository.ts for people's computers: one reading of a GitHub repository
// link. A trailing `/` or `.git` is accepted, repositories compare in lowercase, and owners may hold `_`.
const REPOSITORY = /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9_.-]{0,99})\/([A-Za-z0-9_.-]{1,100}?)(?:\.[Gg][Ii][Tt])?\/?$/;

export function githubRepositoryUrl(value) {
  const match = typeof value === 'string' ? REPOSITORY.exec(value) : null;
  return match && !['.', '..', '.git'].includes(match[2].toLowerCase()) ? `https://github.com/${match[1]}/${match[2]}` : null;
}
export const canonicalGithubRepo = value => githubRepositoryUrl(value)?.toLowerCase() ?? null;
// A link this reading accepts. Stored links may still carry the optional `.git` or `/`: GitHub API paths are built
// from githubRepositoryUrl, which drops them.
export const isGithubRepositoryUrl = value => githubRepositoryUrl(value) !== null;
