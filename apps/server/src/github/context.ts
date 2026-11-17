import { projectDocument } from '../firestore.js';
export const RESOURCES = ['issues', 'pull_requests', 'milestones'] as const;
export type GitHubResource = typeof RESOURCES[number];
export type GitHubContext = { repoUrl: string; repositoryId: number };
export const githubContext = () => projectDocument<GitHubContext>('githubIntegration/current');
