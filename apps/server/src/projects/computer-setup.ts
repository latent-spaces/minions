import type { Transaction } from '../firestore.js';
import { runtimeReadiness } from '../owner/web-agent-starts.js';

/** The engine's one computer is set up once its shared service has reported; setup survives going offline. */
export async function computerSetupStatus(tx: Transaction, profileId: string, at: number) {
  const value = (await tx.get(runtimeReadiness.doc(profileId))).data();
  const reported = value?.profileId === profileId && value.lastSeenAt <= at;
  return { computerComplete: reported, githubComplete: reported && value.github === 'ready' };
}
