export type MapAgent = { id: string; name: string; operatorId: string | null; createdAt: number };
export type RosterPage = { agents: MapAgent[]; next: string | null; serverTime: number };

/** No display cap: pages are bounded; incomplete loading is visible to the caller. */
export async function readMapRoster(read: (cursor: string | null) => Promise<RosterPage>, progress: (agents: MapAgent[]) => void, current: () => boolean) {
  const rows = new Map<string, MapAgent>(), cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    if (!current()) return;
    const page = await read(cursor);
    if (!current()) return;
    for (const row of page.agents) rows.set(row.id, row);
    progress([...rows.values()]);
    cursor = page.next;
    if (cursor && cursors.has(cursor)) throw Error('Repeated map roster cursor');
    if (cursor) cursors.add(cursor);
  } while (cursor);
}
