import { DEFAULT_WORKSPACE_ID } from '../workspaces/schema.js';
import { FieldPath, type Transaction } from '../firestore.js';
import { z } from 'zod';
import { hashToken } from '../auth.js';
import { platformSettings } from '../platform/settings.js';
import { Refusal } from '../errors.js';
import { db, profiles } from '../firestore.js';
import { projectReviewStatus } from './project-review.js';
import { createProjectRecord, approvalOriginalDoc } from '../projects/records.js';
import { cardDefinition, cardDoc, cardVersions, cardVersionId } from '../projects/card.js';
import { initializeSetupCommunication } from '../projects/setup-plan.js';
import { createCommunityDefaults } from '../projects/community-schema.js';
import { cursorAfter, nextCursor } from './pagination.js';
import { assertCommunityActor, type CommunityActor } from './identity.js';
import { projects, proposals, proposalHistory, proposalOperations, type Proposal, type ProposalAuthor,
  type ProposalHistory, proposalDTO, type ProposalDTO } from './records.js';

export const PROPOSAL_ID = z.string().regex(/^[a-f0-9]{64}$/);
export const REQUEST_ID = z.string().regex(/^[\w-]{1,64}$/);
export const REVISION = z.number().int().positive().max(Number.MAX_SAFE_INTEGER - 1);
export { PROPOSAL_CONTENT } from './content.js';
import { PROPOSAL_CONTENT } from './content.js';

type WriteInput = {
  action: 'draft' | 'update' | 'submit' | 'withdraw'; clientId: string;
  proposalId?: string; expectedRevision?: number; content?: unknown;
};
type ReviewInput = { proposalId: string; expectedRevision: number; clientId: string;
  decision: 'changes_requested' | 'approved' | 'rejected'; feedback: string };
const requiredContent = ['goal'] as const;
const PAGE = 20;
const HISTORY_PAGE = 5;
const versionId = (revision: number) => String(revision).padStart(16, '0');
const validate = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Refusal('bad_input', z.prettifyError(parsed.error));
  return parsed.data;
};
// A stored receipt may hold a proposal in the shape stored before person writes.
const replay = ({ proposal, ...rest }: { proposal: ProposalDTO & { id: string } }) =>
  ({ ...rest, proposal, replayed: true });

// The one approved project record of a proposal, written only by authorized proposal approval. The proposer owns
// it privately until the owner finalizes setup and publishes; it starts no model, run, event or fanout and creates no repository or GitHub access. A second record for the same
// proposal fails the transaction.
function admit(tx: Transaction, id: string, proposal: Proposal, admittedBy: string, at: number) {
  tx.create(projects.doc(id), createProjectRecord(proposal.ownerProfileId, admittedBy, id, proposal.submittedRevision!, proposal.content, at));
  tx.create(approvalOriginalDoc(id), { schemaVersion: 1, definition: proposal.content, ownerProfileId: proposal.ownerProfileId,
    reviewerProfileId: admittedBy, proposalId: id, submittedRevision: proposal.submittedRevision!, approvedAt: at });
  const card = { version: 1, definition: cardDefinition(proposal.content), editorProfileId: proposal.ownerProfileId, at };
  tx.create(cardDoc(id), card);
  tx.create(cardVersions(id).doc(cardVersionId(1)), card);
  createCommunityDefaults(tx, id, proposal.ownerProfileId, at);
  initializeSetupCommunication(tx, id, proposal.content.setupPlan, proposal.ownerProfileId, at);
}

// The proposer, signed in as a person on the web form, drafts, updates, submits and withdraws here; owner MCP tools
// only read proposals. Submission queues the current revision for delegated review; only approval creates an unstarted
// project with the proposer as owner.
export async function writeProposal(actor: CommunityActor, input: WriteInput, now: () => number) {
  validate(REQUEST_ID, input.clientId);
  if (!['draft', 'update', 'submit', 'withdraw'].includes(input.action)) throw new Refusal('bad_input', 'Choose a proposal action.');
  // Review receipts are keyed `person:<operatorId>`, so a person's writes use their own prefix: one client request ID
  // used for a write and for a review never collides.
  const actorKey = `person-write:${actor.operatorId}`;
  const receiptId = hashToken(`${actorKey}:${input.clientId}`);
  const id = input.action === 'draft' ? receiptId : validate(PROPOSAL_ID, input.proposalId);
  if (input.action !== 'draft') validate(REVISION, input.expectedRevision);
  const content = ['draft', 'update'].includes(input.action) ? validate(PROPOSAL_CONTENT, input.content) : null;
  const fingerprint = hashToken(JSON.stringify({ action: input.action, id, expectedRevision: input.expectedRevision ?? null, content }));
  return db.runTransaction(async tx => {
    const { operator } = await assertCommunityActor(tx, actor);
    const author: ProposalAuthor = { kind: 'person', id: operator.id };
    const [receipt, current, project] = await Promise.all([tx.get(proposalOperations.doc(receiptId)), tx.get(proposals.doc(id)),
      input.action === 'submit' ? tx.get(projects.doc(id)) : null]);
    if (receipt.exists) {
      if (receipt.data()!.fingerprint !== fingerprint) throw new Refusal('bad_input', 'This request ID was already used with different details. Send the original request again, or use a new request ID.');
      return replay(receipt.data()!.result);
    }
    const at = now();
    let proposal: Proposal;
    if (input.action === 'draft') {
      if (current.exists) throw new Refusal('proposal_conflict', 'This proposal ID already exists. Read the current proposal.');
      proposal = { workspaceId: DEFAULT_WORKSPACE_ID, ownerProfileId: operator.id, createdBy: author, lastWrittenBy: author,
        content: content!, status: 'draft', revision: 1, submittedRevision: null, createdAt: at, updatedAt: at,
        feedback: null, projectId: null };
    } else {
      if (!current.exists || current.data()!.ownerProfileId !== operator.id) throw new Refusal('not_found', 'No proposal of yours has this ID.');
      const before = current.data()!;
      if (before.revision !== input.expectedRevision) throw new Refusal('proposal_conflict', `This proposal changed (now revision ${before.revision}). Reload it, then try again.`);
      if (before.status === 'approved' || before.status === 'withdrawn') {
        throw new Refusal('proposal_state', `This proposal is ${before.status} and can’t be changed. Start a new proposal instead.`);
      }
      if (before.status === 'rejected' && input.action === 'submit') throw new Refusal('proposal_state', 'Revise your rejected proposal before submitting it again.');
      proposal = { ...before, revision: before.revision + 1, updatedAt: at, lastWrittenBy: author };
      if (input.action === 'withdraw') proposal.status = 'withdrawn';
      else {
        if (!['draft', 'changes_requested', 'rejected'].includes(before.status)) throw new Refusal('proposal_state', 'This proposal is being reviewed. Wait for feedback, or withdraw it to make changes.');
        if (input.action === 'update') proposal = { ...proposal, content: content!, status: 'draft' };
        else {
          const missing = (proposal.content.proposalFormat === 'simple' ? ['goal'] as const : requiredContent).filter(k => !proposal.content[k]);
          if (proposal.content.proposalFormat === 'simple') {
            const limits = (await tx.get(platformSettings)).data();
            if (limits?.maxContributors != null && (proposal.content.minContributors ?? 0) > limits.maxContributors) throw new Refusal('bad_input', `The minimum number of contributors can be at most ${limits.maxContributors}.`);
            if (!proposal.content.minContributors) throw new Refusal('bad_input', 'Choose the minimum number of contributors.');
            if (!proposal.content.githubUrl) throw new Refusal('bad_input', 'Add the GitHub repository before submitting.');
          }
          if (missing.length) throw new Refusal('bad_input', `Complete these fields before submitting: ${missing.join(', ')}. Sources and resources can remain unknown.`);
          // Profile links are optional; the reviewer sees the ones saved at submission.
          if (operator.githubUsername || operator.profile?.linkedinProfileUrl) proposal.ownerProfile = { githubUsername: operator.githubUsername ?? null, linkedinProfileUrl: operator.profile?.linkedinProfileUrl ?? null };
          else delete proposal.ownerProfile;
          if (project?.exists) throw new Refusal('proposal_conflict', 'This proposal was already approved and has a project. Open the project instead.');
          proposal = { ...proposal, status: 'submitted', submittedRevision: proposal.revision, projectId: null };
        }
      }
    }
    const result = { proposal: { id, ...proposalDTO(proposal) }, replayed: false };
    const history: ProposalHistory = { action: input.action, revision: proposal.revision, at, actorKind: author.kind,
      actorId: author.id, operatorId: operator.id, content, feedback: null, reviewedRevision: null };
    tx.set(proposals.doc(id), proposal);
    tx.create(proposalHistory(id).doc(versionId(proposal.revision)), history);
    tx.create(proposalOperations.doc(receiptId), { fingerprint, result, recordedAt: at });
    return result;
  });
}

// Review requires a delegated reviewer or approved co-founder session.
export async function reviewProposal(actor: CommunityActor, input: ReviewInput, now: () => number) {
  validate(PROPOSAL_ID, input.proposalId); validate(REQUEST_ID, input.clientId); validate(REVISION, input.expectedRevision);
  validate(z.enum(['changes_requested', 'approved', 'rejected']), input.decision);
  const feedback = validate(z.string().trim().min(1).max(1000), input.feedback);
  const receiptId = hashToken(`person:${actor.operatorId}:${input.clientId}`);
  const fingerprint = hashToken(JSON.stringify({ proposalId: input.proposalId, expectedRevision: input.expectedRevision,
    decision: input.decision, feedback }));
  return db.runTransaction(async tx => {
    const { operator, canReview } = await assertCommunityActor(tx, actor);
    if (!canReview) throw new Refusal('forbidden', 'Only a moderator or the Minions team can review proposals.');
    const [receipt, current, project] = await Promise.all([
      tx.get(proposalOperations.doc(receiptId)), tx.get(proposals.doc(input.proposalId)), tx.get(projects.doc(input.proposalId)),
    ]);
    if (receipt.exists) {
      if (receipt.data()!.fingerprint !== fingerprint) throw new Refusal('bad_input', 'This request ID was already used with different details. Send the original request again, or use a new request ID.');
      return replay(receipt.data()!.result);
    }
    if (!current.exists) throw new Refusal('not_found', 'No submitted proposal has this ID.');
    const before = current.data()!;
    const proposer = await tx.get(profiles.doc(before.ownerProfileId));
    if (!proposer.exists || proposer.data()!.removedAt !== null) throw new Refusal('forbidden', 'The person who sent this proposal no longer has an active Minions account.');
    if (before.revision !== input.expectedRevision) throw new Refusal('proposal_conflict', `This proposal changed (now revision ${before.revision}). Reload it, then try again.`);
    if (before.status !== 'submitted' || before.submittedRevision !== before.revision) throw new Refusal('proposal_state', 'This proposal changed. Review its latest version.');
    if (input.decision === 'approved' && project.exists) throw new Refusal('proposal_conflict', 'This proposal was already approved and has a project. Open the project instead.');
    const at = now();
    const proposal: Proposal = { ...before, status: input.decision, revision: before.revision + 1, updatedAt: at,
      feedback: { decision: input.decision, body: feedback, reviewerProfileId: operator.id, reviewedRevision: before.revision, at },
      projectId: input.decision === 'approved' ? current.id : null };
    if (input.decision === 'approved') admit(tx, current.id, proposal, operator.id, at);
    const result = { proposal: { id: current.id, ...proposalDTO(proposal) }, replayed: false };
    // A whole-document write, so a proposal stored with agent-only author fields is kept in the current shape.
    tx.set(current.ref, proposal);
    tx.create(proposalHistory(current.id).doc(versionId(proposal.revision)), { action: input.decision,
      revision: proposal.revision, at, actorKind: 'person', actorId: operator.id, operatorId: operator.id,
      content: null, feedback, reviewedRevision: before.revision });
    tx.create(proposalOperations.doc(receiptId), { fingerprint, result, recordedAt: at });
    return result;
  });
}

export async function getProposal(actor: CommunityActor, id: string, cursor?: string) {
  validate(PROPOSAL_ID, id);
  const scope = `history:${id}`, after = cursorAfter(cursor, scope);
  return db.runTransaction(async tx => {
    const { operator, canReview } = await assertCommunityActor(tx, actor);
    const stored = (await tx.get(proposals.doc(id))).data(), proposal = stored && stored;
    // Drafts are private to the proposer. A withdrawn proposal can hold a draft that was never submitted (withdrawn before
    // submission, or reopened after a change request and edited), so withdrawn proposals are private too.
    const isPrivate = !proposal || proposal.status === 'draft' || proposal.status === 'withdrawn';
    if (!proposal || (proposal.ownerProfileId !== operator.id && (!canReview || isPrivate))) throw new Refusal('not_found', 'No accessible proposal has this ID.');
    let query = proposalHistory(id).orderBy('revision', 'desc').limit(HISTORY_PAGE + 1);
    if (after) query = query.startAfter(Number(after));
    const [history, project] = await Promise.all([tx.get(query), proposal.projectId ? tx.get(projects.doc(proposal.projectId)) : null]);
    const page = history.docs.slice(0, HISTORY_PAGE);
    let approved = null;
    if (project?.exists) {
      const record = project.data()!, original = (await tx.get(approvalOriginalDoc(project.id))).data();
      if (!original || !record.approval) throw new Refusal('bad_input', 'Something went wrong saving this. Try again in a moment; if it keeps happening, tell the Minions team.');
      // Beta connector/browser DTO stays stable; storage has one current ownership authority.
      approved = { id: project.id, definition: original.definition, adminOperatorId: record.ownerProfileId,
        approvedByOperatorId: record.approval.reviewerProfileId, proposalId: record.approval.proposalId,
        proposalRevision: record.approval.submittedRevision, approvedAt: record.approval.approvedAt,
        admission: 'approved', setupRequired: record.setup.required,
        ...(record.artwork ? { artwork: record.artwork } : {}), status: await projectReviewStatus(tx, project.id, record) };
    }
    return { proposal: { id, ...proposalDTO(proposal) }, project: approved,
      history: page.map(d => { const { content, ...entry } = d.data(); return { ...entry, contentChanged: content !== null }; }),
      next: history.size > HISTORY_PAGE ? nextCursor(scope, page.at(-1)!.id) : null };
  });
}

export async function listProposals(actor: CommunityActor, cursor?: string, reviewQueue: false | true | 'approved' = false, size = PAGE) {
  return db.runTransaction(async tx => {
    const { operator, canReview } = await assertCommunityActor(tx, actor);
    if (reviewQueue && !canReview) throw new Refusal('forbidden', 'Only a moderator or the Minions team can see the review queue.');
    const queueStatus = reviewQueue === 'approved' ? 'approved' : 'submitted';
    const scope = `${reviewQueue === 'approved' ? 'queue-approved' : reviewQueue ? 'queue' : 'own'}:${operator.id}`, after = cursorAfter(cursor, scope);
    let query = proposals.where('workspaceId', '==', DEFAULT_WORKSPACE_ID).where(reviewQueue ? 'status' : 'ownerProfileId', '==', reviewQueue ? queueStatus : operator.id)
      .orderBy(FieldPath.documentId()).limit(size + 1);
    if (after) query = query.startAfter(after);
    const found = await tx.get(query), page = found.docs.slice(0, size);
    const entries = [];
    // At most twenty rows (or the caller's size), with four current-project observations in flight at a time.
    for (let offset = 0; offset < page.length; offset += 4) {
      entries.push(...await Promise.all(page.slice(offset, offset + 4).map(async d => {
        const p = d.data(), approved = reviewQueue === 'approved' && p.projectId ? await tx.get(projects.doc(p.projectId)) : null;
        const projectStatus = approved?.exists ? await projectReviewStatus(tx, approved.id, approved.data()!) : null;
        return { id: d.id, title: projectStatus?.definition.title ?? p.content.title, status: p.status,
          revision: p.revision, submittedRevision: p.submittedRevision, updatedAt: p.updatedAt, projectId: p.projectId,
          ...(reviewQueue === 'approved' ? { projectStatus } : {}) };
      })));
    }
    return { proposals: entries,
      next: found.size > size ? nextCursor(scope, page.at(-1)!.id) : null };
  });
}
