/** Merge access is independent of the Card's review instructions. */
export type ProjectMergePolicy = {
  revision: number;
  mode: 'existing' | 'selected_people';
  selected: { profileId: string; epoch: number }[];
};
export type MergePolicyTarget = {
  projectId: string; repository: string; policyKey: string;
  mode: ProjectMergePolicy['mode']; ownerGithubId: number;
  allowedGithubIds: number[];
};
export type MergePolicyCode = 'verified' | 'removed' | 'github_permissions' | 'github_unavailable' | 'account_mismatch' | 'verification_failed' | 'conflicting_rulesets' | 'empty_repository';
export type MergePolicyView = {
  policy: ProjectMergePolicy;
  enforcement: { state: 'not_enabled' | 'pending' | 'verified' | 'failed' | 'stale'; checkedAt: number | null; code: MergePolicyCode | 'identity_required' | 'too_many_members' | null };
};
