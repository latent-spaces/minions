/** Private human control of an owned current-chat participation. No local capability is exposed. */
export type ParticipationControlKind = 'extend' | 'release' | 'wake' | 'cancel_wake';
export type ParticipationControlState = 'queued' | 'accepted' | 'cancelled' | 'applied' | 'expired' | 'failed';
export type ParticipationControlView = {
  participationId: string; generation: number; scope: string;
  approvedAt: number; deadlineAt: number;
  state: 'approved' | 'active' | 'expired' | 'released' | 'recovery_required';
  updatedAt: number; deviceLastSeenAt: number;
  pending: null | { id: string; actorProfileId?: string; kind: ParticipationControlKind; state: ParticipationControlState;
    approvedAt: number; deadlineAt: number | null; message?: string };
};
export type ParticipationControlInput = {
  id: string; kind: ParticipationControlKind; participationId: string; generation: number;
  expectedDeadlineAt: number; wakeId?: string; minutes?: number; approved: true;
};
export type ParticipationControlReply = { participation: ParticipationControlView; replayed: boolean };
