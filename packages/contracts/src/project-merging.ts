/** Recorded project identities, not a live GitHub authorization audit. */
export type MergingPerson = {
  id: string; name: string; role: 'owner' | 'member'; githubUsername: string | null;
};
export type MergingAgent = {
  id: string; name: string; owner: MergingPerson; connection: 'current' | 'revoked' | 'outdated';
};
export type ProjectMergingAccess = {
  projectId: string; generatedAt: number; repository: string | null;
  people: MergingPerson[]; peopleNext: string | null;
  agents: MergingAgent[]; agentsNext: string | null;
  github: { project: import('./github-access.js').GitHubAccessObservation | null;
    self: import('./github-access.js').GitHubAccessObservation[]; more: boolean };
};
