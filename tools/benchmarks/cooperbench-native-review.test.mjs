import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeReviewFinals } from './cooperbench-native-review.mjs';

const author = { kind: 'agent', id: 'agent-1' };
const peer = { kind: 'agent', id: 'agent-2' };
const other = { kind: 'agent', id: 'agent-3' };
const repository = 'benchmark/project';
const digest = 'f'.repeat(64);
const original = { author: 'writer', publishedAt: 20, headSha: 'a'.repeat(40), pullRequest: 1,
  patchSha256: 'b'.repeat(64), sourceSha256: 'c'.repeat(64) };
const changed = { ...original, publishedAt: 32, headSha: 'b'.repeat(40), pullRequest: 2, patchSha256: 'd'.repeat(64), sourceSha256: 'e'.repeat(64) };
const configured = { id: '01', kind: 'configured', enabled: true, generation: 1, at: 1, reviewerAgentId: null };
const submission = (offer, { id = '02', at = 30, generation = 2 } = {}) => ({ id, at, generation, kind: 'submitted',
  candidate: { generation, repository, headSha: offer.headSha, pullRequest: offer.pullRequest, submittedBy: author } });
const approval = (offer, { id = '08', at = 40, generation = 2, actor = peer, note = `${offer.headSha}; ${digest}.` } = {}) =>
  ({ id, kind: 'verdict', generation, at, verdict: { verdict: 'approved', actor, note } });
const checked = (offer, options = {}) => ({ author: 'writer', peer: 'reviewer', headSha: offer.headSha,
  patchSha256: offer.patchSha256, sourceSha256: offer.sourceSha256, passed: true, testSha256: digest, checkedAt: 25, ...options });
const participants = { writer: { agentId: author.id }, reviewer: { agentId: peer.id }, another: { agentId: other.id } };
const finals = (events, checks, candidates = [original, changed]) => nativeReviewFinals({
  events: [...events, configured].reverse(), candidates, participants, repository,
  withinBudget: at => Number.isFinite(at) && at >= 10 && at <= 50,
  checksFor: () => checks,
});

test('an immutable offered SHA may be tested before or after its task submission', () => {
  for (const at of [20, 25, 30, 35, 40]) {
    const events = [submission(original), approval(original)];
    const [result] = finals(events, [checked(original, { checkedAt: at })]);
    assert.equal(result?.checkedAt, at);
    assert.equal(result.headSha, original.headSha);
    assert.equal(result.submissionEvent.generation, result.verdictEvent.generation);
  }
});

test('the same SHA can reuse a receipt with a verdict for the new generation', () => {
  const resubmission = submission(original, { id: '04', at: 35, generation: 4 });
  const invalidated = { id: '03', at: 33, kind: 'invalidated', generation: 3 };
  const events = [submission(original), invalidated, resubmission];
  assert.deepEqual(finals([...events, approval(original)], [checked(original)]), []);
  const [result] = finals([...events, approval(original, { generation: 4 })], [checked(original)]);
  assert.equal(result?.submissionEvent.generation, 4);
});

test('a changed SHA requires its own receipt and a current-generation approval', () => {
  const events = [submission(original), submission(changed, { id: '04', at: 35, generation: 3 })];
  const originalReceipt = checked(original);
  const changedReceipt = checked(changed, { checkedAt: 34 });
  assert.deepEqual(finals([...events, approval(changed, { generation: 3 })], [originalReceipt]), []);
  assert.deepEqual(finals([...events, approval(original)], [originalReceipt, changedReceipt]), []);
  assert.deepEqual(finals([...events, approval(changed)], [changedReceipt]), []);
  const [result] = finals([...events, approval(changed, { generation: 3 })], [originalReceipt, changedReceipt]);
  assert.equal(result?.headSha, changed.headSha);
});

test('approval follows a live submission, including when events share a timestamp', () => {
  const current = submission(original, { id: '04', at: 40 });
  const receipt = checked(original);
  assert.deepEqual(finals([approval(original, { id: '03' }), current], [receipt]), []);
  const stale = { id: '05', kind: 'observed', generation: 2, at: 40, observation: { status: 'stale' } };
  const invalidated = { ...stale, kind: 'invalidated', generation: 3 };
  assert.deepEqual(finals([current, stale, approval(original)], [receipt]), []);
  assert.deepEqual(finals([current, invalidated, approval(original)], [receipt]), []);
  assert.equal(finals([current, { ...stale, generation: 1 }, approval(original)], [receipt]).length, 1);
  assert.equal(finals([current, approval(original), { ...invalidated, id: '09' }], [receipt]).length, 1);
});

test('approval identifies the receipt from the distinct peer who tested the candidate', () => {
  const events = [submission(original), approval(original)];
  for (const edits of [{ actor: author }, { actor: other }, { note: `${original.headSha}; a${digest}.` }, { note: digest }]) {
    assert.deepEqual(finals([events[0], approval(original, edits)], [checked(original)]), []);
  }
  for (const edits of [{ peer: 'another' }, { passed: false }, { patchSha256: changed.patchSha256 }, { sourceSha256: changed.sourceSha256 }]) {
    assert.deepEqual(finals(events, [checked(original, edits)]), []);
  }
});

test('publication, receipt, task submission and approval must fall within the budget and their causal order', () => {
  const events = [submission(original), approval(original)];
  for (const checkedAt of [9, 19, 41, 51]) assert.deepEqual(finals(events, [checked(original, { checkedAt })]), []);
  assert.deepEqual(finals([submission(original), approval(original, { at: 51 })], [checked(original)]), []);
  assert.deepEqual(finals([submission(original, { at: 19 }), approval(original)], [checked(original)]), []);
  assert.deepEqual(finals(events, [checked(original)], [{ ...original, publishedAt: 9 }]), []);
});
