import type { GitHubAccessObservation, GitHubCachedFacts, GitHubCheckStatus, MergingPerson, ProjectMergingAccess } from '@mlswarm/contracts';

export const githubStatus: Record<GitHubCheckStatus, string> = {
  ok: 'Checked', signed_out: 'GitHub sign-in required', missing: 'GitHub CLI missing',
  forbidden: 'Cannot read', unavailable: 'Unavailable', rate_limited: 'Rate limited', failed: 'Check failed', not_checked: 'Not checked',
};
export const roleLabel = (role: string) => role.charAt(0).toUpperCase() + role.slice(1);
export function savedGitHubFact(source: GitHubAccessObservation, fact: GitHubCachedFacts[keyof GitHubCachedFacts], at: number) {
  return fact.value !== null && (fact.status !== 'ok' || !source.online || fact.lastSuccessAt === null || at - fact.lastSuccessAt > 10 * 60_000);
}

/** A missing list entry is never proof of no access. Names are matched only by GitHub login. */
export function personGitHubAccess(data: ProjectMergingAccess, person: MergingPerson) {
  const self = data.github.self.find(value => value.observer.id === person.id);
  const project = data.github.project;
  const login = self?.account.value?.login ?? person.githubUsername;
  const signInOnly = !self?.account.value;
  if (self?.access.value?.role && self.account.value) return { login, signInOnly, label: roleLabel(self.access.value.role), source: self, fact: self.access };
  if (login && project) {
    const lower = login.toLowerCase();
    const collaborator = project.collaborators.value?.people.find(value => value.login.toLowerCase() === lower);
    if (collaborator) return { login, signInOnly, label: roleLabel(collaborator.role), source: project, fact: project.collaborators };
    if (project.invitations.value?.people.some(value => value.login.toLowerCase() === lower)) return { login, signInOnly, label: 'Invited', source: project, fact: project.invitations };
  }
  return { login, signInOnly, label: 'Unknown', source: self ?? project, fact: self?.access ?? project?.collaborators };
}
