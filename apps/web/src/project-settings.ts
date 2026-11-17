import type { MergeApproval } from './merge-approval.js';

// The project card the owner edits in Settings (CardSettings.tsx): a name, a description (stored as goal) and rules
// (owner, 14 November 2026). Text is sent trimmed, and the version read is the fence.
export const CARD_FIELDS = ['title', 'goal', 'rules'] as const;
export type CardFields = Record<typeof CARD_FIELDS[number], string>;
export function cardFields(definition: { title: string; goal: string; rules?: string }): CardFields {
  return { title: definition.title, goal: definition.goal, rules: definition.rules ?? '' };
}
export function cardBody(fields: CardFields, version: number, baseline: { githubUrl?: string | null; proposalFormat?: 'simple'; minContributors?: number; mergeApproval: MergeApproval }) {
  const rules = fields.rules.trim();
  return { expected_version: version, definition: { title: fields.title.trim(), goal: fields.goal.trim(), ...(rules ? { rules } : {}), mergeApproval: baseline.mergeApproval,
    ...(baseline.githubUrl ? { githubUrl: baseline.githubUrl } : {}), ...(baseline.proposalFormat ? { proposalFormat: baseline.proposalFormat } : {}),
    ...(baseline.minContributors !== undefined ? { minContributors: baseline.minContributors } : {}) } };
}
