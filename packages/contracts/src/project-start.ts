/** A committed project start; acknowledgements belong to each participant. */
export type ProjectStartAnnouncement = {
  revision: number;
  startedAt: number;
  actorName: string | null;
  scheduled: boolean;
  seen: boolean;
  dismissed: boolean;
};
