import type { Transaction } from '../firestore.js';
import type { ProjectStartAnnouncement } from '@mlswarm/contracts';
import { z } from 'zod';
import { collection, currentProjectId, db, inProject } from '../firestore.js';
import { Refusal } from '../errors.js';
import { assertMembership } from './access.js';

type Start = Omit<ProjectStartAnnouncement, 'seen' | 'dismissed'>;
type Receipt = { revision: number; seenAt: number; dismissedAt: number | null };
const source = () => collection<Start>(`projects/${currentProjectId()}/announcements`).doc('start');
const receipt = (profileId: string) => collection<Receipt>(`projects/${currentProjectId()}/startAcknowledgements`).doc(profileId);
export const START_ACKNOWLEDGEMENT = z.object({ revision: z.number().int().positive(), action: z.enum(['seen', 'dismiss']) }).strict();

/** Commits with the start and its agent event. Reading or acknowledging never launches work. */
export function writeStartAnnouncement(tx: Transaction, start: Start) { tx.set(source(), start); }

export function readStartAnnouncement(profileId: string, projectId: string): Promise<ProjectStartAnnouncement | null> {
  return inProject(projectId, () => db.runTransaction(async tx => {
    await assertMembership(tx, profileId);
    const [start, acknowledgement] = await Promise.all([tx.get(source()), tx.get(receipt(profileId))]);
    const value = start.data(), ack = acknowledgement.data();
    if (!value) return null;
    return { ...value, seen: ack?.revision === value.revision, dismissed: ack?.revision === value.revision && ack.dismissedAt !== null };
  }, { readOnly: true }));
}

export function acknowledgeStart(profileId: string, input: z.infer<typeof START_ACKNOWLEDGEMENT>, now: () => number) {
  return db.runTransaction(async tx => {
    await assertMembership(tx, profileId);
    const [start, acknowledgement] = await Promise.all([tx.get(source()), tx.get(receipt(profileId))]);
    if (!start.exists || start.data()!.revision !== input.revision) throw new Refusal('proposal_conflict', 'The project start changed. Reload the project.');
    const before = acknowledgement.data(), current = before?.revision === input.revision ? before : null;
    const at = now();
    tx.set(receipt(profileId), { revision: input.revision, seenAt: current?.seenAt ?? at,
      dismissedAt: current?.dismissedAt ?? (input.action === 'dismiss' ? at : null) });
    return { celebrate: input.action === 'seen' && current === null };
  });
}
