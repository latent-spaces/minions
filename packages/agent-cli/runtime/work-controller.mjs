import { createHash } from 'node:crypto';

// The project state a turn saw, as a bounded value its caller may persist.
export const newsFingerprint = news => createHash('sha256').update(JSON.stringify(news.project)).digest('hex');

// Shared finite-work scheduling policy. Callers own model processes, authorization,
// delivery journals and persistence; this controller never invokes a model or API.
// A restored worker passes what its earlier turns saw (`seen`), so it runs only for news since then.
// A provider usage or rate limit is not a failure (owner, 10 November 2026): the worker waits and tries again at the
// provider's reset time when it named one, otherwise after a growing wait up to `limitMaxWaitMs`, and never stops for it.
export function createWorkController({ quietIntervalMs = 0, quietJitterMs = quietIntervalMs * 0.1, announcementJitterMs = 120000, retryBaseMs = 10000, maxFailures = 3, limitMaxWaitMs = 15 * 60_000, random = Math.random, now = Date.now, deadline = Infinity, first: initial = true, seen = null } = {}) {
  let first = initial, active = false, continuation = seen?.continuation === true, failures = 0, blocked = false;
  let freshAfter = null, fingerprintSeen = seen?.fingerprint ?? null, handledRevision = seen?.handledRevision ?? -1, retryAt = null, announcementAt = null;
  let turnRevision = null, inboxAtTurn = null, awaitingAck = null;
  // limited: the provider limit holding the worker, as { retryAt, resetAt, streak }; a restored worker keeps its wait.
  let limited = Number.isSafeInteger(seen?.limitedUntil) ? { retryAt: seen.limitedUntil, resetAt: seen.limitResetAt ?? null, streak: seen.limitStreak ?? 1 } : null;
  if (limited) { retryAt = limited.retryAt; continuation = true; }
  let quietAt = quietIntervalMs > 0 ? now() + quietIntervalMs : Infinity;
  const jitter = span => Math.max(0, Math.min(1, random())) * span;
  const fingerprint = newsFingerprint;
  function status() { return { first, active, continuation, failures, blocked, handledRevision, retryAt, quietAt, limited: limited && { ...limited } }; }
  return {
    status,
    setDeadline(value) { if (!Number.isSafeInteger(value) || value <= deadline) throw new Error('Worker deadline must increase.'); deadline = value; },
    requestContinuation() { continuation = true; blocked = false; failures = 0; retryAt = limited?.retryAt ?? null; freshAfter = null; awaitingAck = null; },
    beginTurn(news) { active = true; continuation = false; turnRevision = news.work?.revision; inboxAtTurn = { pending: news.pending, acknowledged: news.acknowledged }; fingerprintSeen = fingerprint(news); announcementAt = null; },
    recordOutcome({ kind, continuation: next = false, news, now: time = now(), retryable = true, providerLimited = false, resetAt = null }) {
      const wasActive = active; active = false;
      if (kind === 'interrupted') { if (wasActive) continuation = true; return; }
      first = false; freshAfter = news ?? null;
      quietAt = quietIntervalMs > 0 ? time + quietIntervalMs + jitter(quietJitterMs) : Infinity;
      awaitingAck = kind === 'ok' && inboxAtTurn?.pending > 0 && (news?.acknowledged ?? 0) <= (inboxAtTurn.acknowledged ?? 0) ? inboxAtTurn : null;
      if (kind === 'failed' && providerLimited && retryable) {
        // Not counted toward maxFailures. A reset time the provider named is kept; otherwise the wait doubles.
        const streak = (limited?.streak ?? 0) + 1;
        const reset = Number.isSafeInteger(resetAt) && resetAt > time ? resetAt : null;
        retryAt = reset ?? Math.round(time + Math.min(limitMaxWaitMs, retryBaseMs * 2 ** (streak - 1) * (0.8 + jitter(0.4))));
        // The retry waits for the time, not for new project news.
        limited = { retryAt, resetAt: reset, streak }; continuation = true; freshAfter = null; return;
      }
      if (kind === 'failed') {
        failures++; blocked = !retryable || failures >= maxFailures;
        retryAt = blocked ? null : time + retryBaseMs * 2 ** (failures - 1) * (0.8 + jitter(0.4));
        continuation = !blocked; return;
      }
      if (!awaitingAck) failures = 0; blocked = false; retryAt = null; limited = null;
      continuation = kind === 'send_deferred' || next;
      if (kind === 'ok' && Number.isSafeInteger(turnRevision) && turnRevision >= 0) handledRevision = Math.max(handledRevision, turnRevision);
    },
    decide({ news, pendingDeliveries = 0, notices = 0, steering = false, paused = false, tokenCap = false, now: time = now() } = {}) {
      if (blocked) return { action: 'stop', reason: 'failure_limit' };
      if (!news?.project || typeof news.project.started !== 'boolean' || typeof news.project.paused !== 'boolean') return { action: 'wait', reason: 'unknown_contact' };
      // A closed project ends all of its agents' work; pausing only waits.
      if (news.project.closed) return { action: 'stop', reason: 'project_closed' };
      // The job's end time never ends a worker: it starts no new turn and waits until the owner adds time.
      if (time >= deadline) return { action: 'wait', reason: 'time_up', interrupt: false };
      // At the job's token cap, checked between turns: it waits until the owner raises or removes the cap.
      if (tokenCap) return { action: 'wait', reason: 'token_cap', interrupt: false };
      if (!news.project.started || news.project.paused || paused) return { action: 'wait', reason: 'paused', interrupt: false };
      if (active) return { action: 'wait', reason: 'active' };
      // A held message waits for its delivery, but an owner's steer starts a turn without waiting for it.
      if (pendingDeliveries > 0 && !steering) return { action: 'wait', reason: 'pending_delivery' };
      if (!steering && freshAfter !== null && news === freshAfter) return { action: 'wait', reason: 'fresh_observation' };
      if (awaitingAck && news !== freshAfter) {
        const unacknowledged = (news.acknowledged ?? 0) <= (awaitingAck.acknowledged ?? 0); awaitingAck = null;
        if (unacknowledged) { failures++; blocked = failures >= maxFailures; continuation = !blocked; retryAt = blocked ? null : time + retryBaseMs * 2 ** (failures - 1) * (0.8 + jitter(0.4)); }
        if (!unacknowledged) failures = 0;
        if (blocked) return { action: 'stop', reason: 'unacknowledged_inbox' };
      }
      if (retryAt !== null && time < retryAt) return { action: 'wait', reason: limited ? 'provider_limit' : 'retry_backoff', retryAt };
      const durable = news.work?.runnable === true && Number.isSafeInteger(news.work.revision) && news.work.revision >= 0 && news.work.revision > handledRevision;
      const reason = first ? 'first' : steering ? 'steering' : failures ? 'retry' : continuation ? 'continuation' : durable ? 'durable' : notices > 0 ? 'notices' : news.pending > 0 && (!news.project_only || fingerprint(news) !== fingerprintSeen) ? 'inbox' : fingerprintSeen !== fingerprint(news) ? 'project_change' : time >= quietAt ? 'quiet' : null;
      if (!reason) return { action: 'wait', reason: 'idle' };
      if (reason === 'inbox' && news.project_only && announcementJitterMs > 0) {
        announcementAt ??= time + jitter(announcementJitterMs);
        if (time < announcementAt) return { action: 'wait', reason: 'announcement_backoff', retryAt: announcementAt };
      }
      return { action: 'run', reason };
    },
  };
}
