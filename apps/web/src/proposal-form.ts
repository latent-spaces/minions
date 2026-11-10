import { githubRepositoryUrl } from '@mlswarm/contracts';

// The repository as the service stores it. People type or paste it in several shapes (no https://, www., a trailing
// slash or .git); anything else is not a GitHub repository.
export function repositoryUrl(value: string) {
  return githubRepositoryUrl(value.trim().replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, 'https://github.com/'));
}
