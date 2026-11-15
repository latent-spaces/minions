/** Read-only observations made with an approved computer's github.com login. */
export type GitHubCheckStatus = 'ok' | 'signed_out' | 'missing' | 'forbidden' | 'unavailable' | 'rate_limited' | 'failed' | 'not_checked';
export type GitHubRole = 'admin' | 'maintain' | 'write' | 'triage' | 'read' | 'none';
export type GitHubFact<T> = { status: GitHubCheckStatus; value: T | null };
// merged is absent on installed beta.61 and older reporters; remove optionality
// at the next protocol cutover. Drafts remain in that active report contract.
export type GitHubPullRequestCounts = GitHubFact<{ open: number; drafts: number; merged?: number; complete: boolean }>;
export type GitHubAccessFacts = {
  account: GitHubFact<{ login: string }>;
  access: GitHubFact<{ role: GitHubRole | null; defaultBranch: string }>;
  collaborators: GitHubFact<{ people: { login: string; role: string }[]; complete: boolean }>;
  invitations: GitHubFact<{ people: { login: string; invitedBy: string | null }[]; complete: boolean }>;
  rules: GitHubFact<{ types: string[]; requiredApprovals: number | null; requiredChecks: string[]; complete: boolean }>;
  protection: GitHubFact<{ requiredApprovals: number | null; requiredChecks: string[]; pullRequests: boolean; enforceAdmins: boolean }>;
};
export type GitHubAccessTarget = { projectId: string; membershipEpoch: number; repository: string; scope: 'self' | 'project' };
// Optional for installed beta.59 access reporters (OPE-250); require at the next protocol cutover.
export type GitHubAccessReport = GitHubAccessFacts & { version: 1; projectId: string; membershipEpoch: number; repository: string; checkedAt: number; pullRequests?: GitHubPullRequestCounts };
/** A failed attempt retains earlier successful values with their own receipt time. */
export type GitHubCachedFacts = { [K in keyof GitHubAccessFacts]: GitHubAccessFacts[K] & { lastSuccessAt: number | null } };
export type GitHubAccessObservation = GitHubCachedFacts & {
  pullRequests?: GitHubPullRequestCounts & { lastSuccessAt: number | null };
  observer: { id: string; name: string };
  checkedAt: number; receivedAt: number; online: boolean; scope: 'self' | 'project';
};
