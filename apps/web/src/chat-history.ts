/** The shared ordering contract for both human and agent chat histories. */
export type ChatHistoryMessage = { id: string; createdAt: number };

// Matches the server's (createdAt, document ID) cursor ordering without relying
// on browser locale or the order in which concurrent requests finish.
export function compareChatMessages(a: ChatHistoryMessage, b: ChatHistoryMessage): number {
  return a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Older pages prepend naturally; refreshed rows replace their previous copies. */
export function mergeChatMessages<T extends ChatHistoryMessage>(current: readonly T[], incoming: readonly T[]): T[] {
  const byId = new Map(current.map(message => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort(compareChatMessages);
}

/**
 * Refreshing only the newest page may skip messages when a busy chat advances
 * by more than one page. Keep the visible history intact until the caller has
 * fetched backwards from the newest page and found an overlapping message.
 * A complete response is authoritative, including an empty conversation.
 */
export function mergeLatestChatWindow<T extends ChatHistoryMessage>(
  current: readonly T[], latest: readonly T[], { hasOlder }: { hasOlder: boolean },
): { messages: T[]; gap: boolean } {
  if (!hasOlder) return { messages: mergeChatMessages([], latest), gap: false };
  if (!current.length) return { messages: mergeChatMessages([], latest), gap: false };
  const existing = new Set(current.map(message => message.id));
  if (!latest.some(message => existing.has(message.id))) return { messages: [...current], gap: true };
  return { messages: mergeChatMessages(current, latest), gap: false };
}
