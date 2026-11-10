import { Timestamp, type DocumentReference, type Transaction } from '../firestore.js';
import { V2_LIMITS } from '../config.js';
import { Refusal } from '../errors.js';
import { db } from '../firestore.js';
import { inboxes, inboxItems, itemId, sourceMarkers, type Inbox, type InboxItem, type ItemKind, readReceipts } from './records.js';
import { assertRunInTransaction } from './runs.js';
import { actorSource, messageWithSource, untrusted } from './untrusted.js';

const EMPTY: Inbox = { last: 0, acked: 0, updatedAt: 0 };
const DAY_MS = 86_400_000;

export type Target = { agentId: string; inbox: Inbox; delivered: boolean };
export type Delivery = { sourceId: string; kind: ItemKind; messageId: string | null; payload: object };

// Reads, for one transaction, what delivering a source to these agents needs: each inbox, and
// whether the source was already delivered there. Call before the transaction's writes.
export async function readTargets(tx: Transaction, agentIds: string[], sourceId: string): Promise<Target[]> {
  if (agentIds.length === 0) return [];
  const refs: DocumentReference[] = agentIds.flatMap((id) => [inboxes().doc(id), sourceMarkers(id).doc(sourceId)]);
  const snaps = await tx.getAll(...refs);
  return agentIds.map((agentId, i) => ({
    agentId,
    inbox: (snaps[2 * i].data() as Inbox | undefined) ?? EMPTY,
    delivered: snaps[2 * i + 1].exists,
  }));
}

// Writes only. Gives each target that does not have the source yet its next item, the source
// marker and its new `last`. Returns the number delivered.
export function deliver(tx: Transaction, targets: Target[], delivery: Delivery, at: number): number {
  let count = 0;
  for (const { agentId, inbox, delivered } of targets) {
    if (delivered) continue;
    const seq = inbox.last + 1;
    tx.set(inboxItems(agentId).doc(itemId(seq)), {
      seq, sourceId: delivery.sourceId, kind: delivery.kind, messageId: delivery.messageId,
      payload: { ...delivery.payload }, deliveredAt: at,
    });
    tx.set(sourceMarkers(agentId).doc(delivery.sourceId), { seq });
    tx.set(inboxes().doc(agentId), { last: seq, acked: inbox.acked, updatedAt: at,
      lastDirect: delivery.kind === 'message' || delivery.kind === 'task_assigned' ? seq : (inbox.lastDirect ?? inbox.last) });
    count++;
  }
  return count;
}

export function backlog(inbox: Inbox): number {
  return inbox.last - inbox.acked;
}

export async function readInbox(agentId: string): Promise<Inbox> {
  return (await inboxes().doc(agentId).get()).data() ?? EMPTY;
}

type PublicItem = Pick<InboxItem, 'seq' | 'kind' | 'deliveredAt' | 'payload'>;

// Message bodies, direction titles and assigned task titles reach the agent inside untrusted envelopes. The project card
// in card_changed is approved project context and stays as it is.
function publicPayload(payload: InboxItem['payload']): InboxItem['payload'] {
  if (typeof payload.body === 'string') return messageWithSource(payload as { agentId: string; agentName?: string; body: string });
  if (payload.type === 'direction_opened') return { ...payload, title: untrusted(actorSource(payload.openedBy), payload.title) };
  if (payload.type === 'task_assigned') return { ...payload, title: untrusted(actorSource(payload.titleAuthor), payload.title) };
  return payload;
}

// Moves the agent's acknowledged position to `ack`, then returns the items after it, oldest first:
// at most limit items (pageItems unless given) or pageBytes of them. A forward ack must have been returned to this run;
// one at or below the acknowledged position changes nothing. Until acknowledged, an item is
// returned on every call.
export async function readUpdates(agentId: string, ack: number | undefined, now: () => number, runId?: string, limit: number = V2_LIMITS.pageItems): Promise<{
  items: PublicItem[], position: number, acknowledged: number, has_more: boolean
}> {
  const receiptRef = readReceipts(agentId).doc(runId ?? 'store');
  const { before, acked } = await db.runTransaction(async (tx) => {
    if (runId) await assertRunInTransaction(tx, agentId, runId);
    const inbox = (await tx.get(inboxes().doc(agentId))).data() ?? EMPTY;
    const receipt = (await tx.get(receiptRef)).data();
    if (ack === undefined || ack <= inbox.acked) return { before: inbox.acked, acked: inbox.acked };
    if (ack > inbox.last || !receipt?.positions.includes(ack)) {
      throw new Refusal('bad_input',
        `ack ${ack} doesn’t match a position you were given. Pass the position you received from read_agent_inbox.`);
    }
    tx.set(inboxes().doc(agentId), { ...inbox, acked: ack, updatedAt: now() });
    tx.set(receiptRef, { positions: receipt!.positions.filter((p) => p > ack) });
    return { before: inbox.acked, acked: ack };
  });
  if (acked > before) await expireAcknowledged(agentId, before, acked, now());

  const found = await inboxItems(agentId).where('seq', '>', acked).orderBy('seq')
    .limit(limit + 1).get();
  const items: PublicItem[] = [];
  let bytes = 0;
  for (const doc of found.docs.slice(0, limit)) {
    const { seq, kind, deliveredAt, payload } = doc.data();
    const item = { seq, kind, deliveredAt, payload: publicPayload(payload) };
    bytes += Buffer.byteLength(JSON.stringify(item));
    if (items.length > 0 && bytes > V2_LIMITS.pageBytes) break;
    items.push(item);
  }
  const position = items.at(-1)?.seq ?? acked;
  if (position > acked) await db.runTransaction(async (tx) => {
    if (runId) await assertRunInTransaction(tx, agentId, runId);
    const inbox = (await tx.get(inboxes().doc(agentId))).data() ?? EMPTY;
    const receipt = (await tx.get(receiptRef)).data();
    const positions = (receipt?.positions ?? []).filter((p) => p > inbox.acked);
    if (position > inbox.acked && !positions.includes(position)) positions.push(position);
    tx.set(receiptRef, { positions });
  });
  return {
    items,
    position,
    acknowledged: acked,
    has_more: found.size > items.length,
  };
}

// Gives the newly acknowledged items an expiry time. Nothing else depends on it, so a failure
// only keeps those items longer, and is logged.
async function expireAcknowledged(agentId: string, from: number, to: number, at: number): Promise<void> {
  const expireAt = Timestamp.fromMillis(at + V2_LIMITS.ackedRetentionDays * DAY_MS);
  try {
    for (let start = from + 1; start <= to; start += 500) {
      const batch = db.batch();
      for (let seq = start; seq <= Math.min(to, start + 499); seq++) {
        batch.update(inboxItems(agentId).doc(itemId(seq)), { expireAt });
      }
      await batch.commit();
    }
  } catch (error) {
    console.error(`Could not set the expiry of acknowledged items ${from + 1} to ${to} of ${agentId}.`, error);
  }
}
