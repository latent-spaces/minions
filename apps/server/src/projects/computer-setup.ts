import type { Transaction } from '../firestore.js';
import { computerConnections } from '../owner/computer-access.js';
import { runtimeReadiness } from '../owner/web-agent-starts.js';

/** Setup survives going offline; an ended connection from before 13 November 2026 and account mismatches do not. */
export async function computerSetupStatus(tx: Transaction, profileId: string, at: number) {
  const rows = await tx.get(computerConnections.where('profileId', '==', profileId).where('revokedAt', '==', null).limit(51));
  const connected = rows.docs.filter(row => row.data().approvedAt != null && !!row.data().firebaseUid);
  const reports = connected.length ? await tx.getAll(...connected.map(row => runtimeReadiness.doc(row.id))) : [];
  const githubComplete = reports.some((report, index) => {
    const value = report.data();
    return value?.profileId === profileId && value.connectionId === connected[index].id && value.github === 'ready' && value.lastSeenAt <= at;
  });
  return { computerComplete: connected.length > 0, githubComplete };
}
