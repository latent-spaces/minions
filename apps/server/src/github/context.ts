import { projectDocument } from '../firestore.js';
export const RESOURCES = ['issues', 'pull_requests', 'milestones'] as const;
export type GitHubResource = typeof RESOURCES[number];
export type GitHubContext = { repoUrl: string; repositoryId: number };
export const githubContext = () => projectDocument<GitHubContext>('githubIntegration/current');

export type GitHubSync = GitHubContext & {
  generation: number; leaseUntil: number; readyAt: number; blocked: boolean;
  page: number; since: number | null; cycleStartedAt: number | null; cycleWatermarkAt: number | null; cycleClockKnown: boolean;
  lastPassAt: number | null; lastFullPassAt: number | null; passes: number;
  consecutiveFailures: number; lastFailure: string | null;
  // Malformed replies in a row. Older states lack it; their lastFailure stands in for one.
  invalidResponses?: number;
  pages: number; apiRequests: number; responseBytes: number; objectsObserved: number;
};
export const syncState = (resource: GitHubResource) => projectDocument<GitHubSync>(`githubIntegration/sync-${resource}`);
