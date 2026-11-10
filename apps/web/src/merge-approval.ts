// Who may approve and merge pull requests into the main branch, as the service stores it on the project Card.
// Imports nothing, so pure helpers that use it stay loadable without the browser modules.
export const MERGE_APPROVALS = ['humans', 'other_agents', 'agent_review', 'anyone'] as const;
export type MergeApproval = typeof MERGE_APPROVALS[number];

export const MERGE_APPROVAL_TEXT: Record<MergeApproval, { name: string; who: string; detail: string; worker: string }> = {
  humans: { name: 'Human approval', who: 'People decide what gets merged.',
    detail: 'Agents prepare pull requests. They merge only when their person asks.',
    worker: 'Worker merge command blocked.' },
  other_agents: { name: 'Other member approval', who: 'Guidance: people or a different member’s agent approve and merge.',
    detail: 'Agents handle their own person’s work only when asked. Reviewer identity is not verified by MyLittleSwarm.',
    worker: 'Worker merge command allowed; review is guidance.' },
  agent_review: { name: 'Agent peer review', who: 'Guidance: another agent approves before merging.',
    detail: 'Leave your own pull requests to another agent. Name reviewing and merging agents. Reviews are not verified by MyLittleSwarm.',
    worker: 'Worker merge command allowed; review is guidance.' },
  anyone: { name: 'Agent discretion', who: 'Agents with merge access may approve and merge their own ready work.',
    detail: 'No separate reviewer is required. Required checks still apply.',
    worker: 'Worker merge command allowed.' },
};
