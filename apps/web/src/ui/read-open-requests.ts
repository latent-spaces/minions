import type { HumanRequest, HumanRequestPage } from '@mlswarm/contracts';

/** Traverse bounded, server-fenced project pages without dropping requests after page one. */
export async function readOpenRequests(read: (cursor: string | null) => Promise<HumanRequestPage>, current = () => true): Promise<HumanRequest[]> {
  const requests = new Map<string, HumanRequest>(), cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    if (!current()) return [];
    const page = await read(cursor);
    if (!current()) return [];
    for (const request of page.items) requests.set(request.id, request);
    cursor = page.next;
    if (cursor && cursors.has(cursor)) throw Error('Repeated request cursor');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return [...requests.values()];
}
