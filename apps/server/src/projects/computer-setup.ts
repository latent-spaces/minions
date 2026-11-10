import type { Transaction } from '../firestore.js';
import { collection } from '../firestore.js';
import { runtimeReadiness } from '../owner/web-agent-starts.js';

/** Setup survives going offline; approval revocation/expiry and account mismatches do not. */
export async function computerSetupStatus(tx: Transaction, profileId: string, at: number) {
  const rows = await tx.get(collection<{ profileId: string; approvedAt: number | null; revokedAt: number | null; connectionExpiresAt: number; firebaseUid: string | null }>('computerConnections')
    .where('profileId', '==', profileId).where('revokedAt', '==', null).where('connectionExpiresAt', '>', at).limit(51));
  const approved = rows.docs.filter(row => row.data().approvedAt != null && !!row.data().firebaseUid);
  const reports = approved.length ? await tx.getAll(...approved.map(row => runtimeReadiness.doc(row.id))) : [];
  const githubComplete = reports.some((report, index) => {
    const value = report.data();
    return value?.profileId === profileId && value.connectionId === approved[index].id && value.github === 'ready' && value.lastSeenAt <= at;
  });
  return { computerComplete: approved.length > 0, githubComplete };
}
