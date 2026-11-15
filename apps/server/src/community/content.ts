import { githubRepositoryUrl } from '@minions/contracts';
import { z } from 'zod';
import { SETUP_PLAN } from '../projects/setup-schema.js';

// Who may approve and merge pull requests into the main branch (the project merge policy). Agents read it in their
// project rules as an instruction; nothing on GitHub is locked by it.
export const MERGE_APPROVAL = z.enum(['humans', 'other_agents', 'agent_review', 'anyone']);
export type MergeApproval = z.infer<typeof MERGE_APPROVAL>;

const PROPOSAL_FIELDS = z.object({
  title: z.string().trim().min(1).max(120),
  goal: z.string().trim().max(1500).default(''),
  beneficiaries: z.string().trim().max(1500).default(''),
  output: z.string().trim().max(1500).default(''),
  scope: z.string().trim().max(1500).default(''),
  acceptanceCriteria: z.string().trim().max(1500).default(''),
  sources: z.string().trim().max(1500).nullable().default(null),
  resources: z.string().trim().max(1500).nullable().default(null),
  githubUrl: z.string().trim().max(300).refine(url => githubRepositoryUrl(url) !== null, 'Enter a GitHub repository URL, such as https://github.com/owner/repository.').transform(url => githubRepositoryUrl(url)!).nullable().optional(),
  proposalFormat: z.literal('simple').optional(),
  minContributors: z.number().int().min(1).max(10000).optional(),
  agentGuidance: z.string().trim().max(1500).optional(),
  setupPlan: SETUP_PLAN.optional(),
  mergeApproval: MERGE_APPROVAL.default('humans'),
}).strict();
const withinSize = (content: object, context: z.RefinementCtx) => {
  if (Buffer.byteLength(JSON.stringify(content), 'utf8') > 12_000) {
    context.addIssue({ code: 'custom', message: 'Keep the combined proposal content within 12,000 UTF-8 bytes.' });
  }
};
export const PROPOSAL_CONTENT = PROPOSAL_FIELDS.superRefine(withinSize);
// Links saved under the earlier, looser rule still read, so their projects and proposals stay readable. New content
// uses the GitHub rule above.
const STORED_GITHUB_URL = z.string().trim().max(300).regex(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?$/)
  .transform(url => githubRepositoryUrl(url) ?? url.replace(/\/$/, '')).nullable().optional();


// OPE-233: historical proposal/card/original-approval content may contain voting policy.
// New mutations use PROPOSAL_CONTENT and reject it; archival reads expose only current fields.
export const STORED_PROPOSAL_CONTENT = z.preprocess(value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const { governance: _retired, ...content } = value as Record<string, unknown>;
  return content;
}, PROPOSAL_FIELDS.extend({ githubUrl: STORED_GITHUB_URL }).superRefine(withinSize));
