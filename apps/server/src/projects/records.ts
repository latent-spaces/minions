import { DEFAULT_WORKSPACE_ID } from '../workspaces/schema.js';
import type { Project } from '../firestore.js';
import { currentProjectId, projectDoc, validatedCollection } from '../firestore.js';
import type { ProposalContent } from '../community/records.js';
import { PROJECT_RECORD, readProjectRecord, type ProjectRecord } from './schema.js';
import { Refusal } from '../errors.js';
import { z } from 'zod';
import { STORED_PROPOSAL_CONTENT, type MergeApproval } from '../community/content.js';
import { agentText, cardDoc } from './card.js';

export { PROJECT_RECORD, readProjectRecord, type ProjectRecord } from './schema.js';
export const projects = validatedCollection<ProjectRecord>('projects', readProjectRecord);
export const projectRecordDoc = (id: string) => projects.doc(id);
type ApprovalOriginal = { schemaVersion: 1; definition: ProposalContent; ownerProfileId: string;
  reviewerProfileId: string; proposalId: string; submittedRevision: number; approvedAt: number };
const originalSchema = z.object({ schemaVersion: z.literal(1), definition: STORED_PROPOSAL_CONTENT,
  ownerProfileId: z.string().min(1), reviewerProfileId: z.string().min(1), proposalId: z.string().regex(/^[a-f0-9]{64}$/),
  submittedRevision: z.number().int().positive(), approvedAt: z.number().int().nonnegative() }).strict();
export const approvalOriginalDoc = (id: string) => validatedCollection<ApprovalOriginal>(`projects/${id}/approval`, value => originalSchema.parse(value)).doc('original');

export function createProjectRecord(ownerProfileId: string, reviewerProfileId: string, proposalId: string,
  submittedRevision: number, definition: ProposalContent, approvedAt: number): ProjectRecord {
  return PROJECT_RECORD.parse({ schemaVersion: 1, workspaceId: DEFAULT_WORKSPACE_ID, ownerProfileId,
    ...(definition.setupPlan ? { setupPlan: definition.setupPlan } : {}),
    approval: { proposalId, submittedRevision, reviewerProfileId, approvedAt },
    setup: { required: true, configuredAt: null, configuredByProfileId: null, finalizedAt: null, repoUrl: null,
      minContributors: definition.minContributors ?? null, startDeadline: null },
    execution: { startsAt: 0, paused: true, started: false, awaitingKickoff: true, completedAt: null },
    publication: { listed: false, revision: 0 }, revision: 0 });
}
export type RuntimeState = Omit<Project, 'name' | 'mission' | 'rules'> & { setupFinalizedAt?: number;
  minContributors?: number; startDeadline?: string; revision: number;
  configuredAt: number; configuredBy: string };
export type WorkspaceProject = RuntimeState & Pick<Project, 'name' | 'mission' | 'rules'> & { cardVersion?: number; mergeApproval: MergeApproval };

// Approval creates the parent before configuration; its existence is never execution readiness.
export function runtimeOf(record: ProjectRecord | undefined): RuntimeState | undefined {
  if (!record || record.setup.configuredAt === null) return undefined;
  const { setup, execution } = record;
  if (!setup.repoUrl || !setup.configuredByProfileId) throw new Refusal('bad_input', 'Something went wrong saving this. Try again in a moment; if it keeps happening, tell the MyLittleSwarm team.');
  return { repoUrl: setup.repoUrl, configuredAt: record.setup.configuredAt!,
    configuredBy: setup.configuredByProfileId, revision: record.revision,
    startsAt: execution.startsAt, paused: execution.paused, started: execution.started, awaitingKickoff: execution.awaitingKickoff,
    ...(execution.tokenLimit ? { tokenLimit: execution.tokenLimit } : {}),
    ...(execution.pauseRequest ? { pauseRequest: execution.pauseRequest } : {}),
    ...(setup.finalizedAt !== null ? { setupFinalizedAt: setup.finalizedAt } : {}),
    ...(setup.minContributors !== null ? { minContributors: setup.minContributors } : {}),
    ...(setup.startDeadline !== null ? { startDeadline: setup.startDeadline } : {}),
    ...(execution.completedAt !== null ? { completedAt: execution.completedAt } : {}) };
}
export function runtimeWithCard(record: ProjectRecord | undefined, card: { version: number; definition: ProposalContent } | undefined): WorkspaceProject | undefined {
  const runtime = runtimeOf(record);
  if (!runtime) return undefined;
  if (!card) throw new Refusal('bad_input', 'Something went wrong saving this. Try again in a moment; if it keeps happening, tell the MyLittleSwarm team.');
  return { ...runtime, cardVersion: card.version, ...agentText(card.definition) };
}
// A stored execution.endsAt (see schema.ts) is carried over from `record` unread.
export function recordWithRuntime(record: ProjectRecord, runtime: RuntimeState): ProjectRecord {
  return PROJECT_RECORD.parse({ ...record, revision: runtime.revision,
    setup: { ...record.setup, repoUrl: runtime.repoUrl, configuredAt: runtime.configuredAt,
      configuredByProfileId: runtime.configuredBy, finalizedAt: runtime.setupFinalizedAt ?? null,
      minContributors: runtime.minContributors ?? record.setup.minContributors, startDeadline: runtime.startDeadline ?? null },
    execution: { startsAt: runtime.startsAt, paused: runtime.paused, started: runtime.started,
      awaitingKickoff: runtime.awaitingKickoff ?? false, completedAt: runtime.completedAt ?? null,
      ...(record.execution.endsAt !== undefined ? { endsAt: record.execution.endsAt } : {}),
      ...(runtime.tokenLimit ? { tokenLimit: runtime.tokenLimit } : {}),
      ...(runtime.pauseRequest ? { pauseRequest: runtime.pauseRequest } : {}) } });
}
export async function readRuntime(): Promise<WorkspaceProject | undefined> {
  const [project, card] = await Promise.all([projectDoc().get(), cardDoc(currentProjectId()).get()]);
  return runtimeWithCard(project.data(), card.data());
}
