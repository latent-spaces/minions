// Repository configuration.
import { repositoryUrl } from './proposal-form.js';
import type { MergeApproval } from './merge-approval.js';
export function configureBody(repo: string, revision: number) {
  return { expected_revision: revision, repoUrl: repositoryUrl(repo) ?? repo.trim().replace(/\/$/, '') };
}

// The Card fields the owner edits in Settings (CardSettings.tsx), and the body a save sends. Unknown sources or resources
// start empty, text is sent trimmed, and empty sources or resources are sent as unknown. The version read is the fence.
export const CARD_FIELDS = ['title', 'goal', 'beneficiaries', 'output', 'scope', 'acceptanceCriteria', 'sources', 'resources', 'githubUrl'] as const;
export type CardFields = Record<typeof CARD_FIELDS[number], string>;
export function cardFields(definition: Record<Exclude<typeof CARD_FIELDS[number], 'githubUrl'>, string | null> & { githubUrl?: string | null }): CardFields {
  return Object.fromEntries(CARD_FIELDS.map(field => [field, definition[field] ?? ''])) as CardFields;
}
export function cardBody(fields: CardFields, version: number, baseline: { proposalFormat?: 'simple'; minContributors?: number; mergeApproval: MergeApproval; agentGuidance?: string }) {
  const text = (field: typeof CARD_FIELDS[number]) => fields[field].trim();
  return { expected_version: version, definition: { title: text('title'), goal: text('goal'), beneficiaries: text('beneficiaries'), output: text('output'),
    scope: text('scope'), acceptanceCriteria: text('acceptanceCriteria'), sources: text('sources') || null, resources: text('resources') || null, mergeApproval: baseline.mergeApproval, ...(baseline.agentGuidance !== undefined ? { agentGuidance: baseline.agentGuidance } : {}), ...(text('githubUrl') ? { githubUrl: text('githubUrl') } : {}), ...(baseline.proposalFormat ? { proposalFormat: baseline.proposalFormat } : {}), ...(baseline.minContributors !== undefined ? { minContributors: baseline.minContributors } : {}) } };
}
