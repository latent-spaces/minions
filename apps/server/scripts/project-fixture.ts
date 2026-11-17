// Development-only canonical records shared by local seeds, disposable tests and benchmarks.
import type { ProposalContent } from '../src/community/records.js';
import { cardDefinition, cardDoc, cardVersionId, cardVersions } from '../src/projects/card.js';
import { communityDefaults, communityRulesDoc, communitySettingsDoc, ruleVersionId, ruleVersions } from '../src/projects/community-schema.js';
import { approvalOriginalDoc, createProjectRecord, projectRecordDoc, recordWithRuntime, type RuntimeState } from '../src/projects/records.js';
import { db } from '../src/firestore.js';
import { workspaceDoc, newWorkspaceRecord } from '../src/workspaces/records.js';

export type FixtureProject = { ownerProfileId: string; reviewerProfileId?: string; definition: ProposalContent;
  approvedAt?: number; submittedRevision?: number; required?: boolean; runtime?: RuntimeState; localFixture?: string };

export function fixtureProjectRecords(id: string, input: FixtureProject): Array<{ path: string; body: Record<string, unknown> }> {
  const at = input.approvedAt ?? 0, reviewerProfileId = input.reviewerProfileId ?? input.ownerProfileId;
  const submittedRevision = input.submittedRevision ?? 1;
  let record = createProjectRecord(input.ownerProfileId, reviewerProfileId, id, submittedRevision, input.definition, at);
  if (input.required !== undefined) record = { ...record, setup: { ...record.setup, required: input.required } };
  if (input.runtime) record = recordWithRuntime(record, input.runtime);
  const card = { version: 1, definition: cardDefinition(input.definition), at, editorProfileId: input.ownerProfileId };
  const community = communityDefaults(input.ownerProfileId, at);
  return [
    { path: projectRecordDoc(id).path, body: record },
    { path: approvalOriginalDoc(id).path, body: { schemaVersion: 1, definition: input.definition,
      ownerProfileId: input.ownerProfileId, reviewerProfileId, proposalId: id, submittedRevision, approvedAt: at } },
    { path: cardDoc(id).path, body: card },
    { path: cardVersions(id).doc(cardVersionId(1)).path, body: card },
    { path: communitySettingsDoc(id).path, body: community.settings },
    { path: communityRulesDoc(id).path, body: community.rules },
    { path: ruleVersions(id).doc(ruleVersionId(1)).path, body: community.rules },
    ...(input.localFixture ? [{ path: `localFixtures/${id}`, body: { marker: input.localFixture } }] : []),
  ];
}

export async function seedFixtureProject(id: string, input: FixtureProject): Promise<void> {
  await db.runTransaction(async tx => {
    if (!(await tx.get(workspaceDoc())).exists) tx.create(workspaceDoc(), newWorkspaceRecord(input.approvedAt ?? 0));
  });
  const batch = db.batch();
  for (const record of fixtureProjectRecords(id, input)) batch.set(db.doc(record.path), record.body);
  await batch.commit();
}
