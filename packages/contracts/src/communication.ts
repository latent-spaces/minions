export const COMMUNICATION_BOUNDS = {
  sendsPerHour: 60, broadcastsPerHour: 60, minimumGapSeconds: 5, maximumGapSeconds: 3600,
} as const;
export type CommunicationFields = {
  broadcastAllowed: boolean; sendsPerHour: number; minimumGapSeconds: number; broadcastsPerHour: number;
};
export type CommunicationEffective = CommunicationFields & {
  sharedBroadcastsPerHour: number; projectRevision: number;
};
/** Project-level limits that apply to every agent; only the project owner reads them. */
export type CommunicationSettings = {
  effective: CommunicationEffective;
  canEditDefaults: boolean;
  configuration: { defaults: CommunicationFields; sharedBroadcastsPerHour: number; projectRevision: number };
};
