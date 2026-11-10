// One reading of a GitHub repository link for the server, the website and (mirrored in the connector)
// people's computers. Owner selection, 30 October 2026: a trailing `/` or `.git` is accepted, and
// repositories compare in lowercase. Owners start with a letter or digit and may hold `_` (GitHub Enterprise Managed
// User accounts are named handle_shortcode), so links saved under the earlier rule keep working.
const REPOSITORY = /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9_.-]{0,99})\/([A-Za-z0-9_.-]{1,100}?)(?:\.[Gg][Ii][Tt])?\/?$/;

// Owner and name as written, without the optional suffix; null when this is not a repository link.
export function githubRepositoryParts(value: string | null | undefined): { owner: string; name: string } | null {
  const match = typeof value === 'string' ? REPOSITORY.exec(value) : null;
  if (!match || ['.', '..', '.git'].includes(match[2].toLowerCase())) return null;
  return { owner: match[1], name: match[2] };
}

// The link as written, without the optional suffix.
export function githubRepositoryUrl(value: string | null | undefined): string | null {
  const parts = githubRepositoryParts(value);
  return parts && `https://github.com/${parts.owner}/${parts.name}`;
}

// The comparison identity: two links name the same repository when these are equal.
export const canonicalGithubRepo = (value: string | null | undefined) => githubRepositoryUrl(value)?.toLowerCase() ?? null;
