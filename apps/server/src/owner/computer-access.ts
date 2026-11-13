import type { Transaction } from '../firestore.js';
import { collection, type Agent } from '../firestore.js';
import { Refusal } from '../errors.js';

// The engine serves one owner on this computer, so a computer connects without an approval step and its connection
// does not expire (owner decision, 13 November 2026). Rows connected before then also hold pollingSecretHash,
// expiresAt and connectionExpiresAt from the retired browser approval, and older ones updatePolicy, updateRequest and
// updateActivation from the retired connector self-update; they are kept and not read.
export type ComputerConnection = { requestId: string; candidateTokenHash: string; clientName: string; createdAt: number; approvedAt: number | null;
  revokedAt: number | null; profileId: string | null; firebaseUid: string | null; authenticatedAt: number | null; lastUsedAt?: number;
  pollingSecretHash?: string; expiresAt?: number; connectionExpiresAt?: number | null; revocationCompleteAt?: number | null };
export const computerConnections = collection<ComputerConnection>('computerConnections');

// The connector recognizes this message and connects the computer again by itself, so nobody is asked to act.
export const COMPUTER_DISCONNECTED = 'This computer is no longer connected to MyLittleSwarm.';

// A connection counts while it belongs to the person and was not ended. Only rows from before 13 November 2026 can be
// ended (revokedAt) or never connected (approvedAt null).
export const currentComputer = (computer: Pick<ComputerConnection, 'profileId' | 'approvedAt' | 'revokedAt'> | undefined, profileId: string) =>
  !!computer && computer.profileId === profileId && typeof computer.approvedAt === 'number' && computer.revokedAt === null;

// Registration reads the connection in its write transaction.
export async function assertCurrentComputer(tx: Transaction, id: string, profileId: string) {
  if (!currentComputer((await tx.get(computerConnections.doc(id))).data(), profileId)) throw new Refusal('unauthorized', COMPUTER_DISCONNECTED);
}

export async function agentComputerAllowed(tx: Transaction, agent: Agent) {
  if (agent.computerConnectionId === undefined) return true;
  return currentComputer((await tx.get(computerConnections.doc(agent.computerConnectionId))).data(), agent.ownerProfileId);
}
