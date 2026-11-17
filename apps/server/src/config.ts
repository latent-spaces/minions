
export const LIMITS = {
  messageMaxChars: 2000,
};
// Delivery bounds from Plan v2; communication defaults selected 14 October 2026, broadcasts raised 20 October 2026.
export const V2_LIMITS = {
  recipientsMax: 20,
  minSecondsBetweenSends: 5,
  sendsPerHour: 60,
  projectWidePerHour: 6,
  // Per agent in the team: the project-wide broadcast limit grows with the team.
  sharedBroadcastsPerHour: 6,
  backlogMax: 1000,
  pageItems: 50,
  pageBytes: 64 * 1024,
  findAgentsPage: 20,
  toolCallsPerMinute: 60,
  minSecondsBetweenWaits: 10,
  pollSeconds: 20,
  fanoutBatch: 100,
  fanoutLeaseSeconds: 30,
  fanoutCheckSeconds: 5,
  runActiveSeconds: 90,
  contactWriteSeconds: 60,
  projectCacheSeconds: 5,
  ackedRetentionDays: 7,
};
// Editable communication settings stay within this first-slice envelope.
// These bounds are independent of project defaults and current agent allowances.
export { COMMUNICATION_BOUNDS } from '@minions/contracts';

