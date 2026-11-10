import type { ProposalContent } from '../community/records.js';
// Authored project briefs, not approved projects, working applications or measured outcomes.
export const starterProjects: { id: string; category: string; tags: string[]; content: ProposalContent }[] = [
  { id: 'pocket-garden', category: 'games', tags: ['browser', 'cooperative', 'creative'], content: {
    title: 'Pocket Garden', goal: 'Build a friendly cooperative browser game where friends tend a shared garden.',
    beneficiaries: 'Friends who want a short, welcoming creative game.', output: 'A playable browser prototype with a small shared garden and documented controls.',
    scope: 'One garden, planting and watering, two to four players, simple persistence. No accounts, payments or large open world in the first version.',
    acceptanceCriteria: 'Two independent browsers can join, plant and water together; reconnect preserves garden state; keyboard controls and a clear first-play guide work; changes are reviewed in GitHub.',
    sources: null, resources: null, mergeApproval: 'humans',
  } },
  { id: 'focus-board', category: 'personal-tools', tags: ['local-first', 'productivity', 'browser'], content: {
    title: 'Focus Board', goal: 'Build a private daily planning board that works locally and offline.',
    beneficiaries: 'People who want a lightweight personal planning tool without an account.', output: 'A browser app with a daily board, editable tasks and import/export.',
    scope: 'Three task columns, a focus list, local persistence and JSON backup. No remote sync, tracking or external integrations in the first version.',
    acceptanceCriteria: 'Tasks survive reload and offline use; keyboard users can create and move tasks; exported data imports without loss; storage errors are visible and never silently discard edits.',
    sources: null, resources: null, mergeApproval: 'humans',
  } },
  { id: 'access-check', category: 'developer-tools', tags: ['accessibility', 'open-source', 'testing'], content: {
    title: 'Access Check', goal: 'Build a small open-source tool that helps maintainers find reproducible accessibility problems in their own websites.',
    beneficiaries: 'Open-source maintainers and frontend developers.', output: 'A local CLI and readable report with reproducible examples and remediation guidance.',
    scope: 'Operator-provided local pages, automated semantic checks and report export. No public crawling service, legal certification or claim of complete accessibility coverage.',
    acceptanceCriteria: 'Known fixture defects are reported with element locations; clean fixtures avoid false claims; network targets require explicit operator selection; report separates automated findings from manual review.',
    sources: null, resources: null, mergeApproval: 'humans',
  } },
];
