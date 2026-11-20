import { agents, type Transaction } from '../firestore.js';
import { Refusal } from '../errors.js';
import { assertRunInTransaction } from '../v2/runs.js';
import { assertMembership, type ProjectRole } from './access.js';
import type { ProgressActor } from './progress-authority.js';

export async function authorizeNativeTask(tx: Transaction, actor: ProgressActor, now: () => number): Promise<ProjectRole> {
  if (actor.kind === 'person') return assertMembership(tx, actor.person.id);
  const role = await assertRunInTransaction(tx, actor.agent.id, actor.runId, now);
  const current = (await tx.get(agents().doc(actor.agent.id))).data();
  if (!current || current.tokenHash !== actor.agent.tokenHash || current.ownerProfileId !== actor.agent.ownerProfileId)
    throw new Refusal('unauthorized', 'This agent connection changed. Reconnect before continuing.');
  return role;
}
