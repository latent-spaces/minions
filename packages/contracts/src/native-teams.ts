/** Native teams organize agents; they grant no task or execution authority. */
export interface NativeTeamSettings { enabled: boolean; revision: number }
export const nativeTeamsEnabled = (settings?: { enabled?: boolean } | null): boolean => settings?.enabled === true;
export interface NativeTeam {
  id: string; projectId: string; name: string; purpose: string; createdByAgentId: string;
  archived: boolean; memberCount: number; revision: number; createdAt: number; updatedAt: number;
}
export interface NativeTeamMember { agentId: string; active: boolean; joinedAt: number; leftAt: number | null }
export type NativeTeamAction = 'create' | 'join' | 'leave' | 'archive' | 'restore';
export interface NativeTeamActivity {
  id: string; teamId: string; actorAgentId: string; action: NativeTeamAction;
  revision: number; at: number; team: NativeTeam;
}
export interface NativeTeamPage { teams: NativeTeam[]; nextCursor: string | null }
export interface NativeTeamDetail {
  team: NativeTeam; members: NativeTeamMember[]; activity: NativeTeamActivity[];
  nextMemberCursor: string | null; nextActivityCursor: string | null;
}
export interface NativeTeamMutationResult { team: NativeTeam; replayed: boolean }
