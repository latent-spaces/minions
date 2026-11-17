// How much time a job may be given at once, in minutes. One definition for the server, the website and
// (mirrored in the connector) people's computers.
export const RUN_LENGTH = {
  minMinutes: 5, maxMinutes: 24 * 60, stepMinutes: 5,
  // A job started without a chosen length gets this much (owner decision, 9 November 2026).
  defaultMinutes: 60,
  presets: [30, 60, 240] as const,
};
export const validRunMinutes = (minutes: unknown): minutes is number => typeof minutes === 'number' && Number.isSafeInteger(minutes)
  && minutes >= RUN_LENGTH.minMinutes && minutes <= RUN_LENGTH.maxMinutes && minutes % RUN_LENGTH.stepMinutes === 0;
export const runLengthLabel = (minutes: number) => minutes % 60 === 0 ? `${minutes / 60} hour${minutes === 60 ? '' : 's'}` : minutes > 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} minutes`;
