import type { MergeApproval } from './merge-approval';
import type { ProjectLifecycle } from '@mlswarm/contracts';
import type { Overview } from './api';
export type ProjectRole = 'owner' | 'member';
/** `cover` names the screenshot on the project's newest update; the stamps show it. */
export type ProjectEntry = { archived?: boolean; archiveRevision?: number; starred?: boolean; coverImage?: string; cover?: string; id: string; name: string; summary: string; execution: 'not_configured' | 'ready' | 'paused' | 'active' | 'closed'; role: ProjectRole; participantCount?: number | null; listed?: boolean; state?: ProjectLifecycle; lifecycle?: 'setup' | 'recruiting' | 'active' | 'paused'; minContributors?: number | null; startDeadline?: string | null;
  /** Not listed in Explore. A service from before 18 October 2026 omits it: no lock is shown. */
  private?: boolean;
  /** When the job's time runs out (Unix ms); null without a job. The newest update or message (Unix ms), on the menu's shortcuts. */
  endsAt?: number | null; lastActivityAt?: number | null };
export type ProjectPage = { projects: ProjectEntry[]; next: string | null };
export type PersonalProjectEntry = ProjectEntry & { kind: 'project' | 'proposal'; proposalStatus: string | null; revision: number | null };
export type PersonalProjectPage = { projects: PersonalProjectEntry[]; next: string | null };
export type CardDefinition = { title: string; goal: string; rules?: string; githubUrl?: string | null; proposalFormat?: 'simple'; minContributors?: number; mergeApproval: MergeApproval };
export type CommunityRulesData = { body: string; version: number; updatedAt: number };
// definition is the current Card version (cardVersion); version 1 is the approved idea.
export type Workspace = {
  startAnnouncement?: import('@mlswarm/contracts').ProjectStartAnnouncement | null;
  archived?: boolean; archiveRevision?: number; starred?: boolean;
  setupPlan?: import('@mlswarm/contracts').ProjectSetupPlan; coverImage?: string; cover?: string; conceptImages?: { src: string; title: string }[]; id: string; role: ProjectRole | 'guest'; listed?: boolean; state?: ProjectLifecycle;
  /** When the job's time runs out (Unix ms); null until a length is chosen. Agents then finish their turn and wait. */
  endsAt?: number | null;
  /** The job's token cap, one pool for all the owner's agents in the project; null or absent for no cap. */
  tokenLimit?: { tokens: number } | null; tokensUsed?: number; project: NonNullable<Overview['project']> | null; revision: number; execution: ProjectEntry['execution']; canConfigure: boolean;
  privacy?: { visibility: 'private'; messageProtection: 'server_readable_v1'; createdAt: number; memberLimit: number };
  publicationOrigin?: 'private' | 'owner_conversion' | 'reviewed_proposal';
  setup?: { required: boolean; finalizedAt: number | null; minContributors: number | null; startDeadline: string | null }; participantCount?: number;
  definition: CardDefinition; cardVersion: number;
  /** Optional native teams, off by default (read with nativeTeamsEnabled). */
  nativeTeams?: import('@mlswarm/contracts').NativeTeamSettings;
  /** Optional native tasks, on by default (read with nativeTasksEnabled). */
  nativeTasks?: import('@mlswarm/contracts').NativeTaskSettings; communityRules: CommunityRulesData; previewUrl?: string | null; previewUpdatedAt?: number | null };
export type CardVersion = { version: number; at: number; editorName: string | null; source: 'edit' | 'approved' | 'created'; definition: CardDefinition };
export type Member = { operatorId: string; projectId: string; name: string | null; photo?: import('./profile-photo-api').PublicPhoto | null; character?: import('@mlswarm/contracts').PersonCharacter | null; email: string | null; role: Exclude<ProjectRole, 'owner'>; revision: number; removedAt: number | null; banned?: boolean };
