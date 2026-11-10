import type { Transaction } from '../firestore.js';
import { collection, type Agent } from '../firestore.js';
import { Refusal } from '../errors.js';

// Records approved before 10 November 2026 can also hold updatePolicy, updateRequest and updateActivation from the
// retired connector self-update; they are kept and not read.
export type ComputerConnection = { requestId: string; pollingSecretHash: string; candidateTokenHash: string; clientName: string; createdAt: number; expiresAt: number; approvedAt: number | null; revokedAt: number | null; connectionExpiresAt: number | null; profileId: string | null; firebaseUid: string | null; authenticatedAt: number | null; lastUsedAt?: number; revocationCompleteAt?: number | null };
export const computerConnections = collection<ComputerConnection>('computerConnections');

// Registration reads the grant in its write transaction, fencing concurrent revocation.
export async function assertComputerApproval(tx: Transaction, id: string, profileId: string, at: number) {
  const computer = (await tx.get(computerConnections.doc(id))).data();
  if (!computer || computer.profileId !== profileId || !Number.isFinite(computer.approvedAt) || computer.revokedAt !== null
    || !Number.isFinite(computer.connectionExpiresAt) || at >= computer.connectionExpiresAt!)
    throw new Refusal('unauthorized', 'This computer approval expired or was ended. Approve this computer again.');
}

// Approval expiry retains its existing semantics; explicit revocation also fences agents.
export async function agentComputerAllowed(tx: Transaction, agent: Agent) {
  if (agent.computerConnectionId === undefined) return true;
  const computer = (await tx.get(computerConnections.doc(agent.computerConnectionId))).data();
  return !!computer && computer.profileId === agent.ownerProfileId && Number.isFinite(computer.approvedAt) && computer.revokedAt === null;
}
