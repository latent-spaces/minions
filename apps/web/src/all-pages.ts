export const ALL_PAGES_LIMIT = 25;
/** Each page a full walk reads delays the next walk this long, so one walk averages at most ten requests a minute. */
export const WALK_PAGE_SPACING_MS = 6_000;

export type PageWalk<T> = { items: T[]; complete: boolean; pages: number; startedAt: number };

/** Reads pages in order. Returns null only when cancelled; a walk stopped by the bound keeps its rows with complete false. */
export async function readAllPages<T>(readPage: (cursor: string | null) => Promise<{ items: T[]; next: string | null }>, stopped: () => boolean, limit = ALL_PAGES_LIMIT, now = Date.now): Promise<PageWalk<T> | null> {
  const items: T[] = [], startedAt = now();
  let cursor: string | null = null;
  for (let page = 0; page < limit; page++) {
    if (stopped()) return null;
    const body = await readPage(cursor);
    if (stopped()) return null;
    items.push(...body.items);
    cursor = body.next;
    if (!cursor) return { items, complete: true, pages: page + 1, startedAt };
  }
  return { items, complete: false, pages: limit, startedAt };
}

/** Walks that fit in one refresh interval keep the caller's cadence; longer walks wait in proportion to the pages they read. */
export function walkDue(last: Pick<PageWalk<unknown>, 'pages' | 'startedAt'> | null, now: number, refreshMs: number) {
  if (!last) return true;
  const spacing = last.pages * WALK_PAGE_SPACING_MS;
  return spacing <= refreshMs || now - last.startedAt >= spacing;
}
