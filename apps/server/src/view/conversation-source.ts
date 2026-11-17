import { FieldPath, type Query } from '../firestore.js';
import { agents } from '../firestore.js';
import { Refusal } from '../errors.js';
import { conversationEntries, type ConversationEntry } from '../projects/steering.js';

export function conversationOwner(value: unknown, profileId: string): string | undefined {
  if (value === undefined || value === 'all') return undefined;
  if (value !== 'mine') throw new Refusal('bad_input', 'Choose All or Me + my agents.');
  return profileId;
}

// Each disjoint query stays within Firestore's 30-value limit. Merge bounded
// windows, rather than filtering a page after unrelated messages consumed it.
export async function conversationSource(profileId?: string) {
  const queries: Query<ConversationEntry>[] = [];
  const ownedIds = new Set<string>();
  if (!profileId) queries.push(conversationEntries());
  else {
    for (const kind of ['steering', 'task']) queries.push(conversationEntries().where('kind', '==', kind).where('actorProfileId', '==', profileId));
    const owned = await agents().where('ownerProfileId', '==', profileId).select().get();
    for (const doc of owned.docs) ownedIds.add(doc.id);
    for (let offset = 0; offset < owned.size; offset += 30) {
      queries.push(conversationEntries().where('kind', '==', 'agent_message')
        .where('agentId', 'in', owned.docs.slice(offset, offset + 30).map(doc => doc.id)));
    }
  }
  const scoped = (threadId?: string) => queries.map(query => threadId ? query.where('threadId', '==', threadId) : query);
  return {
    matches(row: ConversationEntry) {
      return !profileId || (row.kind === 'agent_message' ? ownedIds.has(row.agentId) : row.actorProfileId === profileId);
    },
    async window({ threadId, after, startAt, ascending = false, limit }: {
      threadId?: string; after?: [number, string] | null; startAt?: [number, string]; ascending?: boolean; limit: number;
    }) {
      const direction = ascending ? 'asc' : 'desc';
      const pages = await Promise.all(scoped(threadId).map(async base => {
        let query = base.orderBy('createdAt', direction).orderBy(FieldPath.documentId(), direction);
        if (after) query = query.startAfter(...after);
        if (startAt) query = query.startAt(...startAt);
        return (await query.limit(limit).get()).docs.map(doc => doc.data());
      }));
      return pages.flat().sort((a, b) => (a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) * (ascending ? 1 : -1)).slice(0, limit);
    },
    async count(threadId: string) {
      const totals = await Promise.all(scoped(threadId).map(query => query.count().get()));
      return totals.reduce((sum, total) => sum + total.data().count, 0);
    },
  };
}
