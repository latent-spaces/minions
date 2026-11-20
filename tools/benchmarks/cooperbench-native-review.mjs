export const gateRuleVersion = 'cooperbench-native-review-v2';

function noteNamesDigest(note, digest) {
  return note.match(/[a-f0-9]+/gi)?.includes(digest) ?? false;
}

// The runner supplies offers and check receipts it has verified against Git,
// the frozen test bytes and the pinned regression policy.
export function nativeReviewFinals({ events, candidates, repository, participants, withinBudget, checksFor }) {
  const namesById = new Map(Object.entries(participants).map(([name, { agentId }]) => [agentId, name]));
  const finals = [];
  let submitted;
  let reviewerId;
  let enabled = false;
  let decided = false;

  // Native sequence IDs order same-millisecond events. A refresh of an older
  // generation can arrive after a new submission without invalidating it.
  for (const event of events.toSorted((a, b) => a.id.localeCompare(b.id))) {
    if (event.kind === 'configured') {
      enabled = event.enabled;
      reviewerId = event.reviewerAgentId;
      submitted = undefined;
    } else if (event.kind === 'invalidated'
      || (event.kind === 'observed' && event.generation === submitted?.generation && event.observation.status === 'stale')) {
      submitted = undefined;
    } else if (event.kind === 'submitted') {
      submitted = enabled && event.generation === event.candidate.generation ? event : undefined;
      decided = false;
    }

    if (event.kind !== 'verdict' || !submitted || decided || event.generation !== submitted.generation) continue;
    const submission = submitted.candidate;
    const verdict = event.verdict;
    const author = namesById.get(submission.submittedBy.id);
    const peer = namesById.get(verdict.actor.id);
    if (!author || !peer || peer === author || submission.submittedBy.kind !== 'agent' || verdict.actor.kind !== 'agent'
      || (reviewerId && reviewerId !== verdict.actor.id)) continue;
    decided = true;
    if (verdict.verdict !== 'approved' || !withinBudget(event.at) || !withinBudget(submitted.at) || submitted.at > event.at) continue;

    const candidate = candidates.find(offer => offer.author === author && offer.headSha === submission.headSha
      && offer.pullRequest === submission.pullRequest && repository === submission.repository
      && withinBudget(offer.publishedAt) && offer.publishedAt <= submitted.at);
    if (!candidate || !noteNamesDigest(verdict.note, candidate.headSha)) continue;
    for (const receipt of checksFor(peer, candidate)) {
      if (!receipt.passed || receipt.author !== author || receipt.peer !== peer || receipt.headSha !== candidate.headSha
        || receipt.patchSha256 !== candidate.patchSha256 || receipt.sourceSha256 !== candidate.sourceSha256
        || !withinBudget(receipt.checkedAt) || receipt.checkedAt < candidate.publishedAt || receipt.checkedAt > event.at
        || !noteNamesDigest(verdict.note, receipt.testSha256)) continue;
      finals.push({ ...candidate, peer, testSha256: receipt.testSha256, checkedAt: receipt.checkedAt,
        approvedAt: event.at, source: 'minions-native-delivery-review', submissionEvent: submitted, verdictEvent: event });
    }
  }
  return finals;
}
