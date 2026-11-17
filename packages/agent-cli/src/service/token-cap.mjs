// The job's token cap, counted from the turn outcomes the store already keeps (owner decision, 9 November 2026):
// input + cache writes + output; cache reads do not count. Codex reports input including cached input, so its
// cached input is taken out first. A turn whose provider reported no input or output is unknown, never 0: it is
// listed in unknownTurns and not counted. A turn that never reached the model used no tokens and is skipped.
const known = n => Number.isSafeInteger(n) && n >= 0;
// outcomes: a mission snapshot's outcome records.
export function countedTokens(outcomes) {
  let counted = 0, unknownTurns = 0;
  for (const { outcome } of outcomes) {
    if (outcome.delivery === 'not_submitted') continue;
    const usage = outcome.usage, t = usage?.tokens;
    if (!t || !known(t.input) || !known(t.output)) { unknownTurns++; continue; }
    // A missing cache count adds or removes nothing, so an incomplete report errs high.
    const input = usage.inputSemantics === 'includes-cache' && known(t.cacheRead) && t.cacheRead <= t.input ? t.input - t.cacheRead : t.input;
    counted = Math.min(Number.MAX_SAFE_INTEGER, counted + input + (known(t.cacheWrite) ? t.cacheWrite : 0) + t.output);
  }
  return { counted, unknownTurns };
}
// limit: the reply's tokenLimit, null for no cap. The cap is one pool: othersUsed is what it counted outside this mission.
export const tokenCapReached = (tokens, limit) => !!limit && tokens.counted + limit.othersUsed >= limit.tokens;
// Only the known fields are checked; a field a later server adds is ignored, so it never stops the worker.
export function validTokenLimit(limit) {
  return limit === null || !!limit && typeof limit === 'object'
    && Number.isSafeInteger(limit.tokens) && limit.tokens > 0 && known(limit.othersUsed);
}
