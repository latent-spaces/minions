// Client reader for the current-state endpoint (contract C5 v2.2+, research/platform-scale/current-state-contract.md
// on the c2 branch): a first read, then the changes since the last complete cut, any page served by any process. The
// cursor is opaque here (the endpoint may wrap the core's). Pure and
// generic in the row payload so the web map and an MCP client can share it. The web map reads through it by default
// (current-state-source.ts); MCP find_agents still reads its sources per call.

/** A row as the endpoint sends it: the derived agent with its source revision, or a (hard) removal. A row re-derived for a
 * clock-only transition (Offline, Completed, pause_unconfirmed) keeps its source rev and carries `evaluatedAt` (v2.3). */
export type CurrentStateRow<T> = (T & { id: string; rev: string; evaluatedAt?: number }) | { id: string; rev: string; removed: true };
/** `reset`: this page starts a replacement (a dependency changed, c3): it and the pages after it list every agent.
 * `complete` (c2, c3): the answer has ended; absent, it is `!more && !notReady`. `pause` (C7, c3): the project pause,
 * sent whole in every answer (null when not paused). */
export type CurrentStateAnswer<T> = { rows: CurrentStateRow<T>[]; cursor: string; more: boolean; notReady: boolean;
  complete?: boolean; reset?: boolean; pause?: unknown; needsYou: string[]; needsYouComplete: boolean; serverTime: number };
type Live<T> = T & { id: string; rev: string; evaluatedAt?: number };

export type CurrentStateReader<T> = {
  /** The cursor to send next (null: a first read). */
  cursor: string | null;
  /** snapshot: a first read or reset in progress, absent ids are pruned at its end; delta: changes since a complete cut. */
  phase: 'snapshot' | 'delta';
  /** True once an answer has ended (more and notReady false): every row is at its version at the cut P or newer. */
  complete: boolean;
  /** The last answer was notReady: its process is behind the cut. Ask again with the same cursor; nothing changed. */
  notReady: boolean;
  rows: Map<string, Live<T>>;
  /** Hard removals, so a slower process's older row cannot bring the agent back. Kept until a newer row for the id;
   * contract C6 forbids hard deletes, so this stays empty in normal operation. */
  removed: Map<string, string>;
  /** A reset replacement is being paged: its rows are re-derived under new dependencies, so an equal rev wins. */
  replacing: boolean;
  /** Ids delivered by the first read or reset being paged. */
  seen: Set<string>;
  needsYou: Set<string>;
  /** The project pause from the latest applied answer (undefined until an endpoint sends one). */
  pause: unknown;
  serverTime: number;
};

// A greater rev wins. At an equal rev only the rows' own evaluatedAt is compared, never an answer's serverTime: clocks of
// different processes must not order rows (c5, c7). Outside a reset an equal rev wins only when both carry evaluatedAt and
// the incoming one is later (an equal pair is a replay, c2). In a reset replacement an equal rev wins unless both carry
// evaluatedAt and the incoming one is earlier (c5, c7). A removal counts by rev; in a reset an equal-rev removal wins.
function wins(row: CurrentStateRow<unknown>, held: Live<unknown>, replacing: boolean) {
  if (row.rev !== held.rev) return row.rev > held.rev;
  if ('removed' in row) return replacing;
  const known = row.evaluatedAt !== undefined && held.evaluatedAt !== undefined;
  return replacing ? !known || row.evaluatedAt! >= held.evaluatedAt! : known && row.evaluatedAt! > held.evaluatedAt!;
}

export function createReader<T>(): CurrentStateReader<T> {
  return { cursor: null, phase: 'snapshot', complete: false, notReady: false, rows: new Map(),
    removed: new Map(), replacing: false, seen: new Set(), needsYou: new Set(), pause: undefined, serverTime: 0 };
}

/** After the endpoint refuses a cursor: page a first read again, keeping rows until it completes. */
export function restartReader<T>(previous: CurrentStateReader<T>): CurrentStateReader<T> {
  return { ...previous, cursor: null, phase: 'snapshot', complete: false, notReady: false, replacing: false, seen: new Set() };
}

/** Applies the answer to a request sent with `sent`. An answer to any other cursor (a late, duplicate or replayed
 * response) is ignored whole, so a reordered page can neither move the cursor back nor end a first read early.
 * A held row is replaced only by a greater (rev, evaluatedAt) (contract v2.3, c1, c2): an older or equal row from a
 * slower process never brings back an older version, and a re-derived row under the same rev lands only if evaluated
 * later. A process whose clock is behind the cursor's E answers notReady (c3), so it cannot serve an earlier evaluation.
 * Removals count by rev. A reset replacement is the exception: a dependency (access, membership, pause) changed with no
 * source write, so its rows are re-derived at the same rev and must replace what is held (c5). A process with older
 * dependencies cannot serve it: the dependency version is in the cursor, and a stale process answers notReady. */
export function applyCurrentState<T>(previous: CurrentStateReader<T>, sent: string | null, answer: CurrentStateAnswer<T>): CurrentStateReader<T> {
  if (sent !== previous.cursor) return previous;
  if (answer.notReady) return { ...previous, notReady: true };
  const rows = new Map(previous.rows), removed = new Map(previous.removed);
  // A reset page starts the replacement from the beginning: only what it and its following pages list survives.
  const phase = answer.reset ? 'snapshot' : previous.phase;
  const seen = answer.reset ? new Set<string>() : phase === 'snapshot' ? new Set(previous.seen) : previous.seen;
  const replacing = answer.reset === true || previous.replacing;
  for (const row of answer.rows) {
    if (phase === 'snapshot') seen.add(row.id);
    const held = rows.get(row.id), gone = removed.get(row.id);
    if (held && !wins(row, held, replacing)) continue;
    if (gone !== undefined && row.rev <= gone) continue;
    if ('removed' in row) { rows.delete(row.id); removed.set(row.id, row.rev); }
    else { rows.set(row.id, row as Live<T>); removed.delete(row.id); }
  }
  // Needs you is the viewer's current set; an incomplete one (over the server's bound) keeps earlier flags.
  const needsYou = new Set(answer.needsYou);
  if (!answer.needsYouComplete) for (const id of previous.needsYou) needsYou.add(id);
  const serverTime = Math.max(previous.serverTime, answer.serverTime);
  const pause = answer.pause === undefined ? previous.pause : answer.pause;
  const base = { ...previous, cursor: answer.cursor, rows, removed, needsYou, pause, serverTime, notReady: false };
  // Complete (v2.2+: a process behind the cut answers notReady, never more:false): a first read or reset prunes the
  // ids it did not list.
  if (!(answer.complete ?? !answer.more)) return { ...base, phase, seen, replacing, complete: false };
  if (phase === 'snapshot') for (const id of rows.keys()) if (!seen.has(id)) rows.delete(id);
  return { ...base, phase: 'delta', seen: new Set(), replacing: false, complete: true };
}

/** The held rows in id order. */
export const currentStateRows = <T>(reader: CurrentStateReader<T>): Live<T>[] =>
  [...reader.rows.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
