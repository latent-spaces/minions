import type { Transaction } from '../firestore.js';
import type { ProjectStartAnnouncement } from '@mlswarm/contracts';
import { collection, currentProjectId, db, inProject } from '../firestore.js';
import { assertMembership } from './access.js';

type Start = ProjectStartAnnouncement;
const source = () => collection<Start>(`projects/${currentProjectId()}/announcements`).doc('start');

/** Commits with the start and its agent event. Reading it never launches work. */
export function writeStartAnnouncement(tx: Transaction, start: Start) { tx.set(source(), start); }

export function readStartAnnouncement(profileId: string, projectId: string): Promise<ProjectStartAnnouncement | null> {
  return inProject(projectId, () => db.runTransaction(async tx => {
    await assertMembership(tx, profileId);
    return (await tx.get(source())).data() ?? null;
  }, { readOnly: true }));
}

