/** Private owner controls for an already-approved background mission. No time grant. */
export type BackgroundControlKind = 'pause' | 'resume' | 'stop';
export type BackgroundControlState = 'queued' | 'accepted' | 'applied' | 'expired' | 'failed';
export type BackgroundMissionState = 'accepted' | 'starting' | 'running' | 'waiting' | 'blocked' | 'pausing' | 'paused' | 'stopping' | 'stopped' | 'failed' | 'recovery_required';
export type BackgroundTarget = { site: string; ownerId: string; projectId: string; agentId: string };
export type BackgroundControlView = {
  target: BackgroundTarget; missionId: string; generation: number; deadlineAt: number;
  state: BackgroundMissionState; pauseOperationId: string | null;
  updatedAt: number; deviceLastSeenAt: number; available: boolean;
  pending: null | { id: string; actorProfileId?: string; kind: BackgroundControlKind; state: BackgroundControlState; approvedAt: number; message?: string };
};
export type BackgroundControlInput = {
  id: string; kind: BackgroundControlKind; missionId: string; generation: number; approved: true; pauseOperationId?: string;
};
export type BackgroundControlReply = { background: BackgroundControlView; replayed: boolean };

export type ParticipantAgentControlsPage = { items: {agentId:string;name:string;background:BackgroundControlView|null;participation:import('./chat-controls.js').ParticipationControlView|null}[]; next:string|null;serverTime:number };
