// Mirrors packages/contracts/src/run-length.ts for people's computers: the time "work in this chat" may be
// given, 5 minutes to 24 hours in five-minute steps. A job of background agents has no time limit.
export const RUN_LENGTH = Object.freeze({ minMinutes: 5, maxMinutes: 24 * 60, stepMinutes: 5 });
export const MAX_REMAINING_MS = RUN_LENGTH.maxMinutes * 60000;
export const validRunMinutes = minutes => Number.isSafeInteger(minutes) && minutes >= RUN_LENGTH.minMinutes && minutes <= RUN_LENGTH.maxMinutes && minutes % RUN_LENGTH.stepMinutes === 0;
