/** A committed project start: who started it and when. */
export type ProjectStartAnnouncement = {
  revision: number;
  startedAt: number;
  actorName: string | null;
  scheduled: boolean;
};
