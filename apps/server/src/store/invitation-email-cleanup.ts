import { FieldPath, FieldValue, collection, type Transaction } from '../firestore.js';

// Invitations were removed (owner decision, 10 November 2026), but email records sent before then are kept.
// Removing an account still clears the person's email address from them, as it did before.
type Delivery = { ownerProfileId: string; recipientProfileId: string; status: string };
const deliveries = collection<Delivery>('invitationEmails');
const captures = collection<object>('invitationEmailCaptures');
const tokens = collection<{ ownerProfileId: string; recipientProfileId: string }>('invitationEmailStopTokens');

export type InvitationEmailCleanupCursor = Partial<Record<'owner' | 'recipient' | 'ownerTokens' | 'recipientTokens', string>>;
// One bounded page inside the existing durable account cleanup. All reads precede its writes.
export async function prepareInvitationEmailCleanup(tx: Transaction, personId: string, cursor: InvitationEmailCleanupCursor = {}) {
  const keys = ['owner', 'recipient', 'ownerTokens', 'recipientTokens'] as const;
  const pages = await Promise.all(keys.map(key => {
    const source = key.endsWith('Tokens') ? tokens : deliveries;
    const identityField = key.startsWith('owner') ? 'ownerProfileId' : 'recipientProfileId';
    let query = source.where(identityField, '==', personId).orderBy(FieldPath.documentId()).limit(10);
    if (cursor[key]) query = query.startAfter(cursor[key]);
    return tx.get(query);
  }));
  const nextCursor = Object.fromEntries(keys.map((key, index) => [key, pages[index].docs.at(-1)?.id ?? cursor[key] ?? '']));
  return {
    done: pages.every(page => page.size < 10),
    cursor: nextCursor,
    apply: (at: number) => {
      const seen = new Set<string>();
      pages.forEach((page, index) => {
        page.docs.forEach(row => {
          if (seen.has(row.ref.path)) return;
          seen.add(row.ref.path);
          if (index > 1) { tx.delete(row.ref); return; }
          const job = row.data() as Delivery;
          tx.delete(captures.doc(row.id));
          tx.update(row.ref, {
            recipientEmail: FieldValue.delete(), request: FieldValue.delete(), reason: 'account_removed', updatedAt: at,
            status: job.status === 'capturing' || job.status === 'unknown' ? 'unknown' : 'stopped',
          });
        });
      });
    },
  };
}
