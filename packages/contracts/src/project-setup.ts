import type { CommunicationFields } from './communication.js';

/** Owner planning notes. This never grants a role or issues an invitation. */
export type ProjectSetupPlan = {
  peopleNote: string;
  communication: { defaults: CommunicationFields; sharedBroadcastsPerHour: number };
};
