import { useEffect, useMemo, useRef, useState } from 'react';

/** The server answers at most this many ids per lookup. */
export const LABEL_BATCH = 60;
/** A looked-up label (or its absence) is reused this long before the same id is asked again. */
export const LABEL_TTL_MS = 300_000;
/** After a failed lookup, nothing is asked again for this long; the shared reader already waits out a 429. */
export const LABEL_RETRY_MS = 30_000;

export type LabelEntry<T> = { row: T | null; at: number };

/** Ids worth one lookup now: shown on screen, not listed by the directory walk, and never looked up or stale, in server-sized batches. */
export function labelsDue<T>(wanted: Iterable<string>, listed: ReadonlyMap<string, unknown>, cache: ReadonlyMap<string, LabelEntry<T>>, now: number): string[][] {
  const due = [...new Set(wanted)].filter(id => !listed.has(id) && !(now - (cache.get(id)?.at ?? -Infinity) < LABEL_TTL_MS));
  const batches: string[][] = [];
  for (let i = 0; i < due.length; i += LABEL_BATCH) batches.push(due.slice(i, i + LABEL_BATCH));
  return batches;
}

/** Records one answered batch: returned rows by id, and every other asked id as known to be absent. */
export function recordLabels<T extends { id: string }>(cache: Map<string, LabelEntry<T>>, asked: string[], rows: T[], now: number) {
  const found = new Map(rows.map(row => [row.id, row]));
  for (const id of asked) cache.set(id, { row: found.get(id) ?? null, at: now });
}

// Labels for ids a page already shows (task assignees, contributors, comment authors) that the paced directory walk
// has not reached. Batches are read one at a time; the walk's own rows always win, so a lookup never revives a row
// the walk has since dropped. `absent` holds ids the server answered without, so callers can say "no longer here".
export function useLabelLookup<T extends { id: string }>(lookup: ((ids: string[]) => Promise<T[]>) | null, scope: string, wanted: string[], listed: ReadonlyMap<string, T>) {
  const cache = useRef<{ scope: string; entries: Map<string, LabelEntry<T>>; failedAt: number; reading: boolean }>({ scope, entries: new Map(), failedAt: -Infinity, reading: false });
  if (cache.current.scope !== scope) cache.current = { scope, entries: new Map(), failedAt: -Infinity, reading: false };
  const [version, setVersion] = useState(0);
  const [wake, setWake] = useState(0);
  const key = [...new Set(wanted)].sort().join(',');
  const listedRef = useRef(listed); listedRef.current = listed;
  // Re-checks stale or failed ids; a check that finds nothing due sends no request.
  useEffect(() => { const timer = setInterval(() => setWake(w => w + 1), LABEL_RETRY_MS); return () => clearInterval(timer); }, []);
  useEffect(() => {
    const mine = cache.current;
    if (!lookup || !key || mine.reading || Date.now() - mine.failedAt < LABEL_RETRY_MS) return;
    const batches = labelsDue(key.split(','), listedRef.current, mine.entries, Date.now());
    if (!batches.length) return;
    mine.reading = true;
    // A reading started for this scope finishes into its own cache, so a later scope never sees its rows.
    void (async () => {
      for (const batch of batches) {
        const rows = await lookup(batch);
        recordLabels(mine.entries, batch, rows, Date.now());
        if (cache.current === mine) setVersion(v => v + 1);
      }
    })().catch(() => { mine.failedAt = Date.now(); }).finally(() => {
      mine.reading = false;
      // Ids that appeared while this reading ran are checked now rather than at the next wake.
      if (cache.current === mine) setWake(w => w + 1);
    });
  }, [lookup, scope, key, wake]);
  return useMemo(() => {
    const rows = new Map(listed), absent = new Set<string>();
    for (const [id, entry] of cache.current.entries) {
      if (rows.has(id)) continue;
      if (entry.row) rows.set(id, entry.row); else absent.add(id);
    }
    return { rows, absent };
  }, [listed, scope, version]);
}
