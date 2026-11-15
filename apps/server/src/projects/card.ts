import { z } from 'zod';
import { PROPOSAL_CONTENT, STORED_PROPOSAL_CONTENT, type MergeApproval } from '../community/content.js';
import type { ProjectRecord, ProposalContent } from '../community/records.js';
import { validatedCollection } from '../firestore.js';
import { Refusal } from '../errors.js';

// The project Card after approval (owner choice D5, F3). The approved record is version 1 and is never rewritten;
// each owner save is the next numbered version, and the current one is what the workspace, the project list,
// the Explore listing and agents (through the derived runtime text) read.
export type CardDefinition = Omit<ProposalContent, 'setupPlan'>;
export type CardVersion = { version: number; definition: CardDefinition; at: number; editorProfileId: string };
const CARD_VERSION = z.object({ version: z.number().int().positive(),
  definition: STORED_PROPOSAL_CONTENT.refine(value => value.setupPlan === undefined, 'Setup plan belongs to project setup.'),
  at: z.number().int().nonnegative(), editorProfileId: z.string().min(1) }).strict();
export const cardDoc = (projectId: string) => validatedCollection<CardVersion>(`projects/${projectId}/card`, value => CARD_VERSION.parse(value)).doc('current');
export const cardVersions = (projectId: string) => validatedCollection<CardVersion>(`projects/${projectId}/cardVersions`, value => CARD_VERSION.parse(value));
export const cardVersionId = (version: number) => String(version).padStart(16, '0');
export const CARD_EDIT = z.object({
  client_request_id: z.string().regex(/^[\w-]{1,64}$/), expected_version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER - 1),
  // The proposal schema and its 12,000-byte bound.
  definition: PROPOSAL_CONTENT.refine(content => content.setupPlan === undefined, 'Setup plan belongs to project setup.'),
}).strict();

export function cardDefinition({ title, goal, beneficiaries, output, scope, acceptanceCriteria, sources, resources,
  githubUrl, proposalFormat, minContributors, mergeApproval, agentGuidance }: ProposalContent): CardDefinition {
  // Stored definitions can contain additional metadata. Only Card fields may reach the public reader.
  return { title, goal, beneficiaries, output, scope, acceptanceCriteria, sources, resources, mergeApproval, ...(agentGuidance !== undefined ? { agentGuidance } : {}),
    ...(githubUrl !== undefined ? { githubUrl } : {}), ...(proposalFormat !== undefined ? { proposalFormat } : {}),
    ...(minContributors !== undefined ? { minContributors } : {}) };
}
export function currentCard(_project: ProjectRecord, card: CardVersion | undefined): { version: number; definition: ProposalContent } {
  if (!card) throw new Refusal('bad_input', 'Something went wrong saving this. Try again in a moment; if it keeps happening, tell the Minions team.');
  return { version: card.version, definition: card.definition };
}
// What agents are told about merging: an instruction, not a lock. The reasoning, not a format: whoever approves
// needs to understand the change. A person may still ask their own agent to review or merge for them.
const READER = 'A person who did not watch you work may read each pull request and decide whether it goes in. Describe it '
  + 'for them: what changes, why it is worth having and what could go wrong, in plain words and only as long as this change needs.';
const ASKED = 'When your own person asks you to review or merge a pull request for them, do it: that is their decision.';
const MERGING: Record<MergeApproval, string> = {
  humans: 'Only people decide what goes into the main branch. Open pull requests and keep them ready, but do not approve, '
    + 'merge or push to the main branch on your own judgment. ' + ASKED + ' ' + READER,
  other_agents: 'People, or an agent of a different member, approve and merge pull requests into the main branch. Do not '
    + 'approve or merge work from you or another agent of your own person on your own judgment, or push to the main branch. '
    + ASKED + ' ' + READER,
  // Agents on one computer usually share their person's GitHub login, so GitHub cannot record which agent approved
  // or merged. The review and the merge name the agents instead.
  agent_review: 'An agent may merge a pull request into the main branch after a different agent has reviewed it and '
    + 'approved it. Never merge your own pull request, or one that no other agent has approved. Agents may share one '
    + 'GitHub login, so approve with a review comment that names you as the approving agent, and when you merge, add a '
    + 'merge comment naming you as the merging agent and the agent who approved. Do not push to the main branch. ' + READER,
  anyone: 'Any member or agent with merge access may approve and merge pull requests into the main branch, including your own when the work is ready.',
};
// The Card text agents read in get_project, derived again from the current version on every read.
export const agentText = (definition: CardDefinition) => ({ name: definition.title, mission: definition.goal,
  mergeApproval: definition.mergeApproval,
  rules: `Outcome: ${definition.output}\nRules: ${definition.scope}\nAcceptance: ${definition.acceptanceCriteria}\nMerging: ${MERGING[definition.mergeApproval]}${definition.agentGuidance ? `\nProject guidance: ${definition.agentGuidance}` : ''}` });
