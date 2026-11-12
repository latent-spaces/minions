import type { PublicPhoto } from './profile-photo-api';
import type { MergeApproval } from './merge-approval';
import type { ProjectSetupPlan } from '@mlswarm/contracts';
import type { ProjectLifecycle } from '@mlswarm/contracts';
export type CommunityRequest = <T>(path: string, body?: object) => Promise<T>;
export type CommunityAccount = { person: {id: string; name: string; photo?: PublicPhoto | null; character?: import('@mlswarm/contracts').PersonCharacter | null}; canReviewProposals: boolean; canAdminPlatform?: boolean; canInvite?: boolean };
export type ProposalSummary = { id: string; title: string; status: string; revision: number; submittedRevision: number | null; updatedAt: number; projectId: string | null; projectStatus?: ProjectReviewStatus | null };
export type ProposalContent = { title: string; goal: string; beneficiaries: string; output: string; scope: string; acceptanceCriteria: string; sources: string | null; resources: string | null; githubUrl?: string | null; proposalFormat?: 'simple'; minContributors?: number; mergeApproval: MergeApproval; agentGuidance?: string; setupPlan?: ProjectSetupPlan };
// A version is written by the proposer, a signed-in person.
export type ProposalAuthor = { kind: 'person'; id: string };
export type ProposalDetail = { proposal: Omit<ProposalSummary, 'title'> & { operatorId: string; createdBy: ProposalAuthor; lastWrittenBy: ProposalAuthor;
  ownerProfile?: OwnerProfile | null; supportingMaterials?: SupportingMaterial[]; content: ProposalContent; feedback: {body: string; reviewedRevision: number} | null };
  project: {id: string; adminOperatorId: string; status: ProjectReviewStatus} | null; history: {action: string; revision: number; actorKind: ProposalAuthor['kind']}[]; next: string | null };
// The proposer's own draft, update, submit and withdraw; every write returns the resulting version.
export type ProposalWrite = { proposal: { id: string; revision: number; status: string; projectId: string | null }; replayed: boolean };
export type ReviewInput = { expected_revision: number; client_request_id: string; decision: 'approved' | 'changes_requested' | 'rejected'; feedback: string };

export type OwnerProfile = { githubUsername: string | null; linkedinProfileUrl: string | null };
export type MyProfileData = import('@mlswarm/contracts').MyProfile;
export type PublicProfileData = OwnerProfile & { id: string; name: string; bio: string; photo?: PublicPhoto | null; character?: import('@mlswarm/contracts').PersonCharacter | null };
export type SupportingMaterial = { id: string; name: string; mimeType: string; size: number; createdAt: number };
export type MaterialRequest = { upload: (id: string, file: File, revision: number, requestId: string) => Promise<ProposalWrite>; read: (id: string, fileId: string) => Promise<Blob>; remove: (id: string, fileId: string, revision: number, requestId: string) => Promise<ProposalWrite> };

export type ProjectReviewStatus = { id: string; definition: ProposalContent; cardVersion: number; state: ProjectLifecycle; execution: string; listed: boolean;
  participantCount: number; repositoryUrl: string | null; repositoryConfigured: boolean;
  setup: { required: boolean; finalizedAt: number | null; minContributors: number | null; startDeadline: string | null } };
