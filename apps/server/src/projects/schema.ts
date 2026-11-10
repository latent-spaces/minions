import { z } from 'zod';
import { SETUP_PLAN } from './setup-schema.js';

const time = z.number().int().nonnegative();
const profileId = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const projectId = z.string().regex(/^[a-f0-9]{64}$/);
const asset = z.string().regex(/^\/viewer\/project-concepts\/[a-z0-9-]+\.(?:jpg|png)$/);
export const PROJECT_RECORD = z.object({
  schemaVersion: z.literal(1), workspaceId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/), ownerProfileId: profileId,
  approval: z.object({ proposalId: projectId, submittedRevision: z.number().int().positive(),
    reviewerProfileId: profileId, approvedAt: time }).strict().nullable(),
  // Direct creation provenance survives an explicit owner conversion. Public
  // projects created through proposal review retain their separate approval.
  privacy: z.discriminatedUnion('visibility', [
    z.object({ visibility: z.literal('private'), messageProtection: z.literal('server_readable_v1'), createdAt: time }).strict(),
    z.object({ visibility: z.literal('public'), messageProtection: z.literal('server_readable_v1'), createdAt: time,
      convertedAt: time, convertedByProfileId: profileId, disclosure: z.literal('card_output_human_chat_v1') }).strict(),
  ]).optional(),
  setup: z.object({ required: z.boolean(), configuredAt: time.nullable(), configuredByProfileId: profileId.nullable(),
    finalizedAt: time.nullable(), repoUrl: z.string().max(300).nullable(),
    minContributors: z.number().int().min(1).max(10000).nullable(), startDeadline: z.string().nullable() }).strict(),
  execution: z.object({ startsAt: time,
    // Accepted and ignored: the job's end time that projects started before 10 November 2026 stored. A job has no
    // time limit now and nothing reads it. Remove once a migration has cleared it from every stored project.
    endsAt: time.optional(), paused: z.boolean(), started: z.boolean(), awaitingKickoff: z.boolean(), completedAt: time.nullable(),
    tokenLimit: z.object({ tokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict().optional(),
    pauseRequest: z.object({ revision: z.number().int().positive(), requestedAt: time }).strict().optional() }).strict(),
  publication: z.object({ listed: z.boolean(), revision: z.number().int().nonnegative() }).strict(),
  setupPlan: SETUP_PLAN.optional(),
  nativeTasks: z.object({ enabled: z.boolean(), revision: z.number().int().nonnegative() }).strict().optional(),
  nativeTeams: z.object({ enabled: z.boolean(), revision: z.number().int().nonnegative() }).strict().optional(),
  revision: z.number().int().nonnegative(),
  artwork: z.object({ coverImage: asset, conceptImages: z.array(z.object({ src: asset, title: z.string().min(1).max(120) }).strict()).max(2) }).strict().optional(),
}).strict().superRefine((record, ctx) => {
  if ((record.approval === null) !== (record.privacy !== undefined))
    ctx.addIssue({ code: 'custom', message: 'Direct projects retain their creation provenance; reviewed projects retain their approval.' });
  if (record.privacy?.visibility === 'private' && (record.publication.listed || record.setup.required))
    ctx.addIssue({ code: 'custom', message: 'Private projects cannot be listed or require public-proposal finalization.' });
  const configured = record.setup.configuredAt !== null;
  if (configured !== (record.setup.repoUrl !== null && record.setup.configuredByProfileId !== null))
    ctx.addIssue({ code: 'custom', message: 'Configured projects require repository and configuring profile.' });
  if (!configured && [record.setup.repoUrl, record.setup.configuredByProfileId].some(value => value !== null))
    ctx.addIssue({ code: 'custom', message: 'Unconfigured projects cannot contain partial setup authority.' });
  if (!configured && (record.setup.finalizedAt !== null || record.execution.started || record.publication.listed))
    ctx.addIssue({ code: 'custom', message: 'An unconfigured project cannot be finalized, started or listed.' });
  if (record.execution.started && record.execution.awaitingKickoff)
    ctx.addIssue({ code: 'custom', message: 'A started project cannot still await kickoff.' });
  if (record.execution.completedAt !== null && !record.execution.paused)
    ctx.addIssue({ code: 'custom', message: 'Completed projects cannot permit active execution.' });
  if (record.execution.pauseRequest && (!record.execution.paused || !record.execution.started
    || record.execution.completedAt !== null || record.execution.pauseRequest.revision > record.revision))
    ctx.addIssue({ code: 'custom', message: 'A project Pause request belongs to a paused, started, open project revision.' });
});
export type ProjectRecord = z.infer<typeof PROJECT_RECORD>;
export const isPrivateProject = (record: { privacy?: { visibility: string } } | undefined | null): boolean =>
  !!record?.privacy && record.privacy.visibility !== 'public';
export const isConvertedProject = (record: Pick<ProjectRecord, 'privacy'> | undefined | null): boolean =>
  record?.privacy?.visibility === 'public';

// OPE-233: existing stored projects retain archival policy fields. Ignore only these
// retired keys on reads; unrelated unknown fields still fail the strict schema.
export const STORED_PROJECT_RECORD = z.preprocess(value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const omit = (input: unknown, keys: string[]) => input && typeof input === 'object' && !Array.isArray(input)
    ? Object.fromEntries(Object.entries(input).filter(([key]) => !keys.includes(key))) : input;
  return { ...record, approval: omit(record.approval, ['proposedGovernance']),
    setup: omit(record.setup, ['governance', 'minCountdownS', 'maxCountdownS']) };
}, PROJECT_RECORD);
export function readProjectRecord(value: unknown): ProjectRecord {
  return STORED_PROJECT_RECORD.parse(value);
}
