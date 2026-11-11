import { db, profiles } from '../firestore.js';
import { Refusal } from '../errors.js';

/** The feedback API is gone (owner, 11 November 2026), but reports sent before then stay
 * stored until their author's account is removed; this deletes them, one bounded page at a time.
 * Remove once no feedbackReports remain. No active account can be purged. */
export async function cleanupFeedback(operatorId: string) {
  return db.runTransaction(async tx => {
    const person = await tx.get(profiles.doc(operatorId));
    if (!person.exists || typeof person.data()!.removedAt !== 'number') throw new Refusal('forbidden', 'Remove the account before cleaning up feedback.');
    const page = await tx.get(db.collection('feedbackReports').where('authorId', '==', operatorId).limit(20));
    for (const d of page.docs) { tx.delete(d.ref); tx.delete(db.collection('feedbackScreenshots').doc(d.id)); }
    tx.delete(db.doc(`feedbackBudgets/${operatorId}`));
    return page.size < 20;
  });
}
