import type { ProjectLifecycle } from '@minions/contracts';
export const categories = { games: 'Games', 'developer-tools': 'Developer tools', 'personal-tools': 'Personal tools', research: 'Research', creative: 'Creative', community: 'Community' } as const;
export type Category = keyof typeof categories;
export type CatalogProject = { id: string; title: string; coverImage?: string; summary: string; category: Category; tags: string[]; publishedAt: number; updatedAt: number; participantCount: number | null; setupPending?: boolean; state?: ProjectLifecycle; status: 'queued' | 'paused' | 'running' | 'closed'; stars: number | null; trending: number | null; minContributors?: number | null; startDeadline?: string | null };
export type CatalogPage = { startingSoon?: CatalogProject[]; projects: CatalogProject[]; next: string | null; generatedAt: number; observedAt: number; participantCountSemantics: 'registered_project_members_plus_owner'; ranking: { kind: string; trendingAvailable: boolean; reason: string } };
export type CatalogSettings = { id: string; revision: number; listed: boolean; summary: string | null; category: Category | null; tags: string[] };
export type ProjectRequest = <T>(path: string, body?: object) => Promise<T>;
