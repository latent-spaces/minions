import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { gateRuleVersion, nativeReviewFinals } from './cooperbench-native-review.mjs';

const { values } = parseArgs({ options: { 'run-dir': { type: 'string' } } });
assert(values['run-dir'], 'Use --run-dir to select an archived treatment run directory.');
const dir = resolve(values['run-dir']);
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const commit = /^[a-f0-9]{40}$/;
const digest = /^[a-f0-9]{64}$/;
const fixture = read(join(dir, 'fixture.json'));
const archived = read(join(dir, 'gate.json'));
const regression = read(join(dir, 'regression.json'));
const { arm, repo, repository, base, participants } = fixture;
assert.equal(arm, 'treatment');
assert(commit.test(base));
assert(Array.isArray(archived.nativeEvents));
const expectedCounts = ['tests', 'failures', 'errors', 'skipped'];
assert(expectedCounts.every(key => Number.isSafeInteger(regression.expected?.[key])));

const time = raw => typeof raw === 'string' ? Date.parse(raw) : raw < 1e12 ? raw * 1000 : raw;
const start = time(fixture.startedAt ?? fixture.startedUnix);
const deadline = time(fixture.deadline ?? fixture.deadlineUnix);
assert(Number.isFinite(start) && Number.isFinite(deadline) && start <= deadline);
const withinBudget = ms => Number.isFinite(ms) && ms >= start && ms <= deadline;
const git = (...args) => execFileSync('git', ['-C', repo, ...args], {
  env: { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' }, maxBuffer: 64 * 1024 * 1024,
});
const refHead = ref => git('rev-parse', '--verify', ref).toString().trim();
const participantNames = Object.keys(participants);
assert(participantNames.every(name => /^[a-zA-Z0-9_-]+$/.test(name)));
assert.equal(new Set(Object.values(participants).map(p => p.agentId)).size, participantNames.length);

function records(kind, participant) {
  const path = join(dir, 'gate-evidence', kind, participant);
  return existsSync(path) ? readdirSync(path, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.json')).map(entry => read(join(path, entry.name))) : [];
}

const candidates = participantNames.flatMap(author => records('offers', author).map(offer => {
  assert.equal(offer.author, author);
  assert.equal(offer.baseSha, base);
  assert(commit.test(offer.headSha) && digest.test(offer.sourceSha256));
  assert(Number.isSafeInteger(offer.pullRequest) && offer.pullRequest > 0);
  assert.equal(offer.ref, `refs/coopbench/pulls/${offer.pullRequest}/head`);
  assert.equal(refHead(offer.ref), offer.headSha);
  assert.equal(refHead(`refs/coopbench/candidates/${offer.headSha}`), offer.headSha);
  assert.equal(refHead(`${offer.headSha}^`), base);
  assert.equal(hash(git('diff', '--no-ext-diff', '--binary', base, offer.headSha, '--')), offer.patchSha256);
  return offer;
}));

function checksFor(peer, offer) {
  return records('checks', peer).filter(row => row.author === offer.author && row.headSha === offer.headSha
    && row.sourceSha256 === offer.sourceSha256).map(row => {
    assert(digest.test(row.testSha256));
    assert.equal(hash(readFileSync(join(dir, 'gate-evidence', 'checks', peer, row.testSha256 + '.py'))), row.testSha256);
    const counts = row.test?.counts;
    const passed = row.regression?.passed === true && row.regression.exitCode === 0
      && expectedCounts.every(key => row.regression.counts?.[key] === regression.expected[key])
      && row.test?.passed === true && row.test.exitCode === 0 && counts?.tests > counts?.skipped
      && counts?.failures === 0 && counts?.errors === 0;
    assert.equal(row.passed, passed);
    return row;
  });
}

const accepted = nativeReviewFinals({ events: archived.nativeEvents, candidates, repository: repository.toLowerCase(),
  participants, withinBudget, checksFor });
accepted.sort((a, b) => a.approvedAt - b.approvedAt || a.headSha.localeCompare(b.headSha));
console.log(JSON.stringify({ gateRuleVersion, final: accepted[0] ?? null }, null, 2));
