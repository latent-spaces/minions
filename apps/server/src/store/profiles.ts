import { agentComputerAllowed } from '../owner/computer-access.js';
import { activeRecipientOperators, connectionAllowed } from '../projects/access.js';
import { accountCleanup, continueAccountCleanup } from './account-cleanup.js';
import { platformOwnership } from '../community/records.js';
import { hashToken } from '../auth.js';
import { Refusal } from '../errors.js';
import { agents, db, profiles, type Agent, type WithId } from '../firestore.js';
import { DISPLAY_NAME } from '../display-name.js';

export async function invitePerson(name: string, email: string): Promise<{ personId: string }> {
  const parsedName = DISPLAY_NAME.safeParse(name);
  if (!parsedName.success) throw new Refusal('bad_input', parsedName.error.issues[0].message);
  const lower = email.trim().toLowerCase();
  const ref = profiles.doc();
  await db.runTransaction(async (tx) => {
    const existing = await tx.get(profiles.where('email', '==', lower).where('removedAt', '==', null).limit(1));
    if (!existing.empty) {
      throw new Refusal('duplicate', `${lower} is already invited.`);
    }
    tx.set(ref, { name: parsedName.data, email: lower, removedAt: null });
  });
  return { personId: ref.id };
}

// Community-wide removal. Scoped offboarding uses setMembership instead.
// Existing direct callers are trusted backend/admin code; public routes never accept this authority.
export async function removePerson(personId: string, now: () => number): Promise<void> {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(personId)) throw new Refusal('bad_input', 'Choose a registered account ID.');
  await db.runTransaction(async tx => {
    const [person, existing, settings] = await Promise.all([
      tx.get(profiles.doc(personId)), tx.get(accountCleanup.doc(personId)), tx.get(platformOwnership),
    ]);
    if (!person.exists) throw new Refusal('not_found', 'No such person.');
    if (person.data()!.removedAt === null && settings.data()?.ownerProfileId === personId) {
      throw new Refusal('forbidden', 'Transfer community ownership before removing its current owner.');
    }
    const at = now(), removedAt = person.data()!.removedAt ?? at;
    if (person.data()!.removedAt === null) tx.update(person.ref, { removedAt });
    // A rerun keeps the existing cleanup record and its cursor.
    if (!existing.exists) tx.create(accountCleanup.doc(personId), {
      operatorId: personId, removedAt, createdAt: at, updatedAt: at, cursor: '', status: 'pending',
      revokedAgents: 0,
    });
  });
  try { await continueAccountCleanup(personId, now); }
  catch { console.error('The account removal was accepted; bounded cross-project cleanup remains pending.'); }
}

// Null if the token is unknown, the agent is revoked or its owner was removed.
export async function agentByToken(token: string): Promise<WithId<Agent> | null> {
  const tokenHash = hashToken(token);
  // The lookup runs in the same read-only snapshot as the checks, so the agent document is read once.
  return db.runTransaction(async tx => {
    const current = (await tx.get(agents().where('tokenHash', '==', tokenHash).limit(1))).docs[0];
    if (!current || current.data().revokedAt !== null || current.data().tokenHash !== tokenHash) return null;
    if (!await agentComputerAllowed(tx, current.data()!)) return null;
    const operators = await activeRecipientOperators(tx, [current.data()!.ownerProfileId]);
    return connectionAllowed(current.data()!, operators) ? { id: current.id, ...current.data()! } : null;
  }, { readOnly: true });
}
