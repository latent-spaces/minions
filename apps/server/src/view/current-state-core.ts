// CS2b (current-state contract C5/C6, research/platform-scale/current-state-contract.md): the pure core of a per-process
// projection of one project's status documents. A listener feeds it snapshots (changed documents + the snapshot's
// readTime W); it answers "everything" or "what changed since a cursor" so that any process can serve any client's
// cursor. No Firestore, no clocks: revisions are commit times (document updateTime, snapshot readTime) passed in.
//
// Gate 1 (pinned cut, c9's wm-paged model c383aea4; c1, c6, c8): an answer pins the cut P = the serving process's W on
// its first page and pages the documents by id, each at its current head. A later page is served only by a process with
// W ≥ P, otherwise "not ready" with the same cursor, never a false complete (codex-1, codex-2, c9). The last page ends at
// (P, ALL): every document is held at its version at P or a newer one, and the next answer sends what changed after P.
// The pass visits each changed id once, so an answer ends in ⌈changed / pageSize⌉ pages whatever the write rate.

/** A commit time at full precision, as a fixed-width string so that string order is time order. */
export type Rev = string;
export function rev(seconds: number, nanoseconds: number): Rev {
  if (!Number.isSafeInteger(seconds) || seconds < 0 || !Number.isInteger(nanoseconds) || nanoseconds < 0 || nanoseconds > 999_999_999)
    throw new RangeError('A commit time has whole seconds and nanoseconds.');
  return `${String(seconds).padStart(12, '0')}.${String(nanoseconds).padStart(9, '0')}`;
}

export type Change<T> = { type: 'added' | 'modified'; id: string; updateTime: Rev; data: T } | { type: 'removed'; id: string; updateTime?: Rev };
export type Row<T> = { id: string; rev: Rev; data: T } | { id: string; rev: Rev; removed: true };
/** `notReady`: this process's W is behind the cursor's cut; nothing was sent, ask again (any process) with the same cursor. */
export type Answer<T> = { rows: Row<T>[]; cursor: string; more: boolean; notReady: boolean };

const ID = /^[A-Za-z0-9_-]{1,200}$/, REV = /^\d{12}\.\d{9}$/;

/** Cursors (all fields are commit times or ids, '.'-separated):
 * - complete `P.~`: the client holds every document at its version at P or newer; the next answer sends rev > P.
 * - snapshot page `s.P.id`: a first read in progress, pinned at P, live documents after `id` still to come.
 * - delta page `B.P.id`: changes since B in progress, pinned at P, documents after `id` still to come. */
const ALL = '~';  // the complete marker ([A-Za-z0-9_-] ids never equal it)
type Cursor = { base: Rev | null; pin: Rev; after: string | null };
const encode = (c: Cursor) => c.after === null ? `${c.pin}.${ALL}` : `${c.base ?? 's'}.${c.pin}.${c.after}`;
export function decodeCursor(value: unknown): Cursor | null {
  if (typeof value !== 'string' || value.length > 260) return null;
  const p = value.split('.');
  const at = (i: number) => `${p[i]}.${p[i + 1]}`;
  if (p.length === 3 && p[2] === ALL && REV.test(at(0))) return { base: at(0), pin: at(0), after: null };
  if (p.length === 4 && p[0] === 's' && REV.test(at(1)) && ID.test(p[3]!)) return { base: null, pin: at(1), after: p[3]! };
  if (p.length === 5 && REV.test(at(0)) && REV.test(at(2)) && at(0) < at(2) && ID.test(p[4]!)) return { base: at(0), pin: at(2), after: p[4]! };
  return null;
}

/** First index in a sorted array whose key is greater than `key` (or ≥ with `orEqual`). */
function bound<E>(items: E[], key: string, of: (e: E) => string, orEqual = false) {
  let lo = 0, hi = items.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; const k = of(items[mid]!); if (k < key || (!orEqual && k === key)) lo = mid + 1; else hi = mid; }
  return lo;
}

/** Value equality with object keys in any order (status documents are plain JSON data). */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every(k => Object.hasOwn(b, k) && same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}
/** Two different contents under one commit time: the feed is not what it claims to be. The binding drops the listener. */
export class ProjectionConflict extends Error {}

export function createProjection<T>(opts: { pageSize?: number } = {}) {
  const pageSize = opts.pageSize ?? 500;
  const docs = new Map<string, { rev: Rev; data: T } | { rev: Rev; removed: true }>();
  // Indexes so that a read costs what it returns, not the project's size (c1, c9): every id in order, and a log of
  // (rev, id) in rev order, one entry per change of a document's head. A re-delivered unchanged document (a listener
  // resume or replay) adds nothing (c1, c13, supervisor probe). A delta walks the log after its base; superseded entries
  // are skipped (their id's head has moved on) and compacted away once they outnumber the documents.
  const ids: string[] = [];
  let log: { rev: Rev; id: string }[] = [];
  let w: Rev | null = null, visits = 0, broken: ProjectionConflict | null = null;

  return {
    /** The listener's watermark: every commit at or before it is reflected here (null until the first snapshot). */
    get watermark() { return w; },
    /** Documents and log entries visited by reads so far (CPU work, for the model; not database reads). */
    get visits() { return visits; },
    /** Applies one listener snapshot. Writers remove a status document softly, with a field (contract C6), which arrives
     * as an ordinary modification. A hard delete has no commit time of its own, so it takes the snapshot's readTime,
     * which differs per process: it is outside the guarantee (c9), kept only so that a deleted row is not served. */
    apply(changes: Change<T>[], readTime: Rev) {
      if (!REV.test(readTime)) throw new RangeError('A snapshot carries its readTime.');
      if (w !== null && readTime < w) return;  // an older snapshot never moves the watermark back
      if (broken) throw broken;
      // One commit time names one content, within a snapshot and across them: a replay at the same time is a no-op.
      // Different content refuses the whole snapshot before anything changes, and the projection stops answering until
      // the binding re-attaches a fresh one (c13, c9): no answer ever carries one rev with two contents.
      const staged = new Map<string, { rev: Rev; data: T }>();
      for (const change of changes) {
        if (change.type === 'removed') { staged.delete(change.id); continue; }
        const known = staged.get(change.id) ?? docs.get(change.id);
        if (known && !('removed' in known) && known.rev === change.updateTime && !same(known.data, change.data))
          throw (broken = new ProjectionConflict(`Document ${change.id} changed content without a new commit time.`));
        if (!known || known.rev <= change.updateTime) staged.set(change.id, { rev: change.updateTime, data: change.data });
      }
      const accepted: { rev: Rev; id: string }[] = [], added: string[] = [];
      for (const change of changes) {
        const known = docs.get(change.id);
        if (change.type === 'removed') {
          if (known && 'removed' in known && known.rev >= (change.updateTime ?? readTime)) continue;
          if (change.updateTime && known && known.rev > change.updateTime) continue;
          docs.set(change.id, { rev: change.updateTime ?? readTime, removed: true });
        } else if (!known || known.rev < change.updateTime || ('removed' in known && known.rev === change.updateTime))
          docs.set(change.id, { rev: change.updateTime, data: change.data });
        else continue;  // older, or the same version again
        if (!known) added.push(change.id);
        accepted.push({ rev: docs.get(change.id)!.rev, id: change.id });
      }
      // New ids: placed one by one when few, otherwise appended and sorted once (a first snapshot is n log n, not n²).
      if (added.length > 64) { ids.push(...added); ids.sort(); }
      else for (const id of added) ids.splice(bound(ids, id, x => x), 0, id);
      accepted.sort((a, b) => (a.rev < b.rev ? -1 : a.rev > b.rev ? 1 : 0));
      for (const entry of accepted) {
        // Changes after the last snapshot sort after the log's tail; an older one (a first sighting) is placed in order.
        if (!log.length || log.at(-1)!.rev <= entry.rev) log.push(entry);
        else log.splice(bound(log, entry.rev, e => e.rev), 0, entry);
      }
      if (log.length > 2 * docs.size + 64) {
        const kept = new Set<string>();
        log = log.filter(e => docs.get(e.id)!.rev === e.rev && !kept.has(e.id) && !!kept.add(e.id));
      }
      w = readTime;
    },
    /** Everything (no cursor) or the changes since a cursor this or another process returned. */
    read(cursorValue?: unknown): Answer<T> {
      if (broken) throw broken;
      if (w === null) throw new Error('The projection has no snapshot yet.');
      let cursor: Cursor;
      if (cursorValue === undefined) cursor = { base: null, pin: w, after: null };
      else {
        const given = decodeCursor(cursorValue);
        if (!given) throw new RangeError('Use a cursor this feed returned.');
        // Behind the cut: this process lacks commits the client may already hold. Mid-answer that is "not yet", never done.
        if (given.pin > w) return { rows: [], cursor: encode(given), more: given.after !== null, notReady: true };
        // Complete and nothing committed since: answer without visiting a document (codex-1, 7ed98ed0).
        if (given.after === null && given.pin === w) return { rows: [], cursor: encode(given), more: false, notReady: false };
        cursor = given.after === null ? { base: given.pin, pin: w, after: null } : given;
      }
      const { base, after } = cursor;
      const row = (id: string): Row<T> => { const doc = docs.get(id)!; return 'removed' in doc ? { id, rev: doc.rev, removed: true } : { id, rev: doc.rev, data: doc.data }; };
      let found: string[] = [];
      if (base === null) {
        // A first read lists current documents in id order from the cursor: about one page of visits.
        for (let i = after === null ? 0 : bound(ids, after, x => x); i < ids.length && found.length <= pageSize; i++) {
          visits++;
          if (!('removed' in docs.get(ids[i]!)!)) found.push(ids[i]!);
        }
      } else {
        // A delta: the heads committed after its base. From the log when it holds fewer entries after the base than there
        // are ids left to walk; otherwise in id order from the cursor, stopping after a page. Each page visits at most
        // min(log entries after B, ids after the cursor), so a multi-page delta costs at most that times its pages (c9).
        const from = bound(log, base, e => e.rev), start = after === null ? 0 : bound(ids, after, x => x);
        if (log.length - from <= ids.length - start) {
          const seen = new Set<string>();
          for (let i = from; i < log.length; i++) {
            visits++;
            const { rev: at, id } = log[i]!;
            if (docs.get(id)!.rev === at && (after === null || id > after) && !seen.has(id)) { seen.add(id); found.push(id); }
          }
          found.sort();
        } else {
          for (let i = start; i < ids.length && found.length <= pageSize; i++) {
            visits++;
            if (docs.get(ids[i]!)!.rev > base) found.push(ids[i]!);
          }
        }
      }
      const more = found.length > pageSize;
      found = found.slice(0, pageSize);
      const next: Cursor = more ? { ...cursor, after: found.at(-1)! } : { base: cursor.pin, pin: cursor.pin, after: null };
      return { rows: found.map(row), cursor: encode(next), more, notReady: false };
    },
  };
}
