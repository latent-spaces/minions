// How much time "work in this chat" may be given at once, in minutes. One definition for the server, the
// website and (mirrored in the connector) people's computers. A job of background agents has no time limit.
export const RUN_LENGTH = { minMinutes: 5, maxMinutes: 24 * 60, stepMinutes: 5 };
export const validRunMinutes = (minutes: unknown): minutes is number => typeof minutes === 'number' && Number.isSafeInteger(minutes)
  && minutes >= RUN_LENGTH.minMinutes && minutes <= RUN_LENGTH.maxMinutes && minutes % RUN_LENGTH.stepMinutes === 0;
