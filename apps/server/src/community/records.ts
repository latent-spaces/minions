import { STORED_PROPOSAL_CONTENT } from './content.js';
import { collection } from '../firestore.js';

export type ProposalContent = import('zod').infer<typeof import('./content.js').PROPOSAL_CONTENT>;
type ProposalStatus = 'draft' | 'submitted' | 'changes_requested' | 'approved' | 'rejected' | 'withdrawn';
// A version is written by the proposer, a signed-in person.
export type ProposalAuthor = { kind: 'person'; id: string };
export type OwnerProfile = { githubUsername: string | null; linkedinProfileUrl: string | null };
export type SupportingMaterial = { id: string; name: string; mimeType: string; size: number; createdAt: number };
export type Proposal = {
  workspaceId: string;
  ownerProfile?: OwnerProfile; supportingMaterials?: SupportingMaterial[];
  ownerProfileId: string; createdBy: ProposalAuthor; lastWrittenBy: ProposalAuthor;
  content: ProposalContent; status: ProposalStatus; revision: number;
  submittedRevision: number | null; createdAt: number; updatedAt: number;
  feedback: { decision: string; body: string; reviewerProfileId: string; reviewedRevision: number; at: number } | null;
  projectId: string | null;
};
export type ProposalDTO = Omit<Proposal, 'ownerProfileId' | 'feedback'> & { operatorId: string;
  feedback: (Omit<NonNullable<Proposal['feedback']>, 'reviewerProfileId'> & { reviewerId: string }) | null };
// The published beta connector and browser consume operatorId/reviewerId; those fields are DTO only.
export function proposalDTO(record: Proposal): ProposalDTO {
  const { ownerProfileId, feedback, ...rest } = record;
  const publicFeedback = feedback && (() => { const { reviewerProfileId, ...entry } = feedback; return { ...entry, reviewerId: reviewerProfileId }; })();
  return { ...rest, content: STORED_PROPOSAL_CONTENT.parse(rest.content), operatorId: ownerProfileId, feedback: publicFeedback };
}
export type ProposalHistory = {
  action: string; revision: number; at: number; actorKind: 'person'; actorId: string;
  operatorId: string; content: ProposalContent | null; feedback: string | null;
  reviewedRevision: number | null;
};
export type { ProjectRecord } from '../projects/records.js';
export { projects } from '../projects/records.js';
export const platformOwnership = collection<{ ownerProfileId: string; configuredAt: number }>('platformSettings').doc('ownership');
export const proposals = collection<Proposal>('proposals');
export const proposalOperations = collection<{
  fingerprint: string; result: { proposal: ProposalDTO & { id: string }; replayed: boolean }; recordedAt: number;
}>('proposalOperations');
export const proposalHistory = (id: string) => collection<ProposalHistory>(`proposals/${id}/history`);
