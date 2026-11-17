// Snapshot syncs are also the computer's liveness signal: the cloud stamps
// deviceLastSeenAt on each one and reports Offline after 90 s. A periodic page
// whose rows match the last server-confirmed copy is skipped until it is
// refreshMs old. 40 s sits a tick-length below the third 15 s tick, so timer
// jitter cannot push the stamp to the fourth tick: a healthy computer stamps every
// 45 s and two consecutive failed syncs still stamp by 75 s, inside the 90 s window.
// Changed, failed or unconfirmed rows always send.
export function createConfirmedSnapshots({ refreshMs = 40000, now = Date.now } = {}) {
  if (!Number.isSafeInteger(refreshMs) || refreshMs < 1 || refreshMs > 60000 || typeof now !== 'function')
    throw new TypeError('Snapshot refresh must stay inside the 90 s computer freshness window.');
  const confirmed = new Map();
  const key = row => JSON.stringify([row.target.projectId, row.target.agentId]);
  return {
    // True only when every row was confirmed unchanged within refreshMs.
    fresh(rows) {
      const at = now();
      return rows.length > 0 && rows.every(row => {
        const saved = confirmed.get(key(row));
        return saved && saved.body === JSON.stringify(row) && at - saved.at < refreshMs;
      });
    },
    // sentAt is taken before the request, so age is never understated.
    confirm(rows, sentAt) { for (const row of rows) confirmed.set(key(row), { body: JSON.stringify(row), at: sentAt }); },
    // Drop rows for bindings this installation no longer serves.
    retain(targets) {
      const live = new Set(targets.map(target => key({ target })));
      for (const id of confirmed.keys()) if (!live.has(id)) confirmed.delete(id);
    },
  };
}
