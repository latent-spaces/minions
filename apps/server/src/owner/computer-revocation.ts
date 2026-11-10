import { prepareCurrentStateProgress } from '../view/current-state-progress.js';
import { FieldPath } from '../firestore.js';
import { db, type Agent } from '../firestore.js';
import { Refusal } from '../errors.js';
import { computerConnections } from './computer-access.js';
import { writeAgentGroup } from '../v2/agent-group.js';

const PAGE = 100;
const agentPath = /^projects\/([a-f0-9]{64})\/agents\/([\w-]{1,200})$/;

// Use the existing account-cleanup index, including projects the person has left.
async function eachOwnedAgent(profileId: string, visit: (path: string) => Promise<void>) {
  let cursor: string | undefined;
  for (;;) {
    let query = db.collectionGroup('agents').where('ownerProfileId', '==', profileId)
      .where('revokedAt', '==', null).orderBy(FieldPath.documentId()).limit(PAGE);
    if (cursor) query = query.startAfter(db.doc(cursor));
    const page = await query.get();
    for (const agent of page.docs) {
      if (!agentPath.test(agent.ref.path)) throw new Refusal('bad_input', 'An agent connection namespace needs maintenance.');
      await visit(agent.ref.path);
    }
    if (page.size < PAGE) return;
    cursor = page.docs.at(-1)!.ref.path;
  }
}

// Older registrations omitted the grant ID. Only authenticated runtime snapshots are
// evidence of their computer: names and local folder strings are never identity.
async function bindOlderAgent(profileId: string, path: string) {
  await db.runTransaction(async tx => {
    const ref = db.doc(path), agent = (await tx.get(ref)).data() as Agent | undefined;
    if (!agent || agent.ownerProfileId !== profileId || agent.revokedAt !== null
      || agent.tokenIssuedAt === null || agent.computerConnectionId) return;
    const [, projectId, agentId] = agentPath.exec(path)!;
    const records = await tx.getAll(db.doc(`projects/${projectId}/backgroundControls/${agentId}`), db.doc(`projects/${projectId}/chatControls/${agentId}`));
    const candidates = records.map(row => row.data()).filter(row => row?.target?.ownerId === profileId
      && row.target.projectId === projectId && row.target.agentId === agentId && typeof row.connectionId === 'string'
      && Number.isSafeInteger(row.deviceLastSeenAt)).sort((a, b) => b!.deviceLastSeenAt - a!.deviceLastSeenAt);
    const chosen = candidates[0];
    if (!chosen || candidates.some(row => row!.deviceLastSeenAt === chosen.deviceLastSeenAt && row!.connectionId !== chosen.connectionId))
      throw new Refusal('intent_conflict', 'An older agent connection does not identify its computer. Reconnect your existing agents from their coding agents, or revoke them in their projects, then try again.');
    const computer = (await tx.get(computerConnections.doc(chosen.connectionId))).data();
    if (!computer || computer.profileId !== profileId || computer.approvedAt === null)
      throw new Refusal('intent_conflict', 'An older agent’s computer approval needs maintenance before computer access can be revoked.');
    tx.update(ref, { computerConnectionId: chosen.connectionId });
  });
}

export async function revokeComputer(profileId: string, id: string, now: () => number) {
  const ref = computerConnections.doc(id), initial = (await ref.get()).data();
  if (!initial || initial.profileId !== profileId) throw new Refusal('unauthorized', 'This computer approval is unavailable.');
  if (initial.revokedAt !== null && initial.revocationCompleteAt != null) return;
  // Refuse an ambiguous legacy association before claiming that access was revoked.
  if (initial.revokedAt === null) await eachOwnedAgent(profileId, path => bindOlderAgent(profileId, path));
  await db.runTransaction(async tx => {
    const computer = (await tx.get(ref)).data();
    if (!computer || computer.profileId !== profileId) throw new Refusal('unauthorized', 'This computer approval is unavailable.');
    if (computer.revokedAt === null) tx.update(ref, { revokedAt: now(), revocationCompleteAt: null });
  });
  // The grant fence already rejects new registration, tokens and in-flight writes.
  // Per-agent transactions fence runs and credentials together, with safe exact retries.
  await eachOwnedAgent(profileId, async path => {
    await db.runTransaction(async tx => {
      const agentRef = db.doc(path), agent = (await tx.get(agentRef)).data() as Agent | undefined;
      if (!agent || agent.ownerProfileId !== profileId || agent.computerConnectionId !== id || agent.revokedAt !== null) return;
      const [, projectId, agentId] = agentPath.exec(path)!;
      const runRef = db.doc(`projects/${projectId}/runs/${agentId}`), contactRef = db.doc(`projects/${projectId}/presence/${agentId}`);
      const [run, contact] = await tx.getAll(runRef, contactRef);
      const statusProgress = await prepareCurrentStateProgress(tx, [contactRef]);
      const at = now();
      tx.update(agentRef, { revokedAt: at });
      const stopping = run.exists && run.data()!.endedAt === null;
      if (stopping) tx.update(runRef, { endedAt: at, endReason: 'computer_revoked' });
      writeAgentGroup(tx, contactRef, { ...agent, revokedAt: at }, stopping && contact.exists ? { at, endedRun: true } : undefined, statusProgress);
    });
  });
  await ref.update({ revocationCompleteAt: now() });
}
