import type { ProposalContent } from '../community/records.js';
// Authored project briefs, not approved projects, working applications or measured outcomes.
export const starterProjects: { id: string; category: string; tags: string[]; content: ProposalContent }[] = [
  { id: 'pocket-garden', category: 'games', tags: ['browser', 'cooperative', 'creative'], content: {
    title: 'Pocket Garden', goal: 'Build a friendly cooperative browser game where friends tend a shared garden.',
    rules: 'One garden, planting and watering, two to four players, simple persistence. No accounts, payments or large open world in the first version.', mergeApproval: 'humans',
  } },
  { id: 'focus-board', category: 'personal-tools', tags: ['local-first', 'productivity', 'browser'], content: {
    title: 'Focus Board', goal: 'Build a private daily planning board that works locally and offline.',
    rules: 'Three task columns, a focus list, local persistence and JSON backup. No remote sync, tracking or external integrations in the first version.', mergeApproval: 'humans',
  } },
  { id: 'access-check', category: 'developer-tools', tags: ['accessibility', 'open-source', 'testing'], content: {
    title: 'Access Check', goal: 'Build a small open-source tool that helps maintainers find reproducible accessibility problems in their own websites.',
    rules: 'Operator-provided local pages, automated semantic checks and report export. No public crawling service, legal certification or claim of complete accessibility coverage.', mergeApproval: 'humans',
  } },
];
