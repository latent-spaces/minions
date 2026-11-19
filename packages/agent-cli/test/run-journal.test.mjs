import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createRunJournal, readRunJournal } from '../src/run-journal.mjs';

const identity = {
  target: {
    site: 'http://127.0.0.1:8787',
    ownerId: 'owner',
    projectId: 'project',
    agentId: 'agent',
  },
  missionId: '123e4567-e89b-42d3-a456-426614174000',
  generation: 1,
  provider: 'claude',
  model: 'sonnet',
};
const turnId = '123e4567-e89b-42d3-a456-426614174001';
const attemptId = '123e4567-e89b-42d3-a456-426614174002';
const directories = new Set();

test.after(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'minions-run-journal-'));
  directories.add(directory);
  if (process.platform !== 'win32') chmodSync(directory, 0o700);
  return {
    directory,
    journal: createRunJournal({ directory, identity }),
  };
}

function block(overrides = {}) {
  return {
    name: 'Agent instructions',
    source: 'instructions',
    bytes: 24,
    sha256: 'a'.repeat(64),
    delivery: 'full',
    ...overrides,
  };
}

function appendManifest(journal, blocks) {
  return journal.append({ kind: 'prompt_manifest', turnId, attemptId, blocks });
}

test('prompt manifests round-trip metadata without storing prompt text', () => {
  const { directory, journal } = fixture();
  const promptText = 'private instructions stay out of this journal';
  const manifest = block({
    bytes: Buffer.byteLength(promptText),
    sha256: createHash('sha256').update(promptText).digest('hex'),
  });

  assert.equal(appendManifest(journal, [manifest]).availability, 'available');

  const result = readRunJournal({ directory, identity });
  assert.equal(result.availability, 'available');
  assert.deepEqual(result.records.map(record => record.kind), ['prompt_manifest']);
  assert.deepEqual(result.records[0].blocks, [manifest]);
  assert.equal(readFileSync(join(directory, 'run-evidence.jsonl'), 'utf8').includes(promptText), false);
});

test('prompt manifests accept all documented block-count and field limits', () => {
  const { directory, journal } = fixture();
  const blocks = Array.from({ length: 32 }, (_, index) => block({
    name: String(index).padEnd(80, 'n'),
    source: 's'.repeat(150),
    bytes: 1_000_000_000,
    delivery: index % 2 ? 'unchanged' : 'full',
  }));

  assert.equal(appendManifest(journal, blocks).availability, 'available');
  const result = readRunJournal({ directory, identity });
  assert.equal(result.availability, 'available');
  assert.deepEqual(result.records[0].blocks, blocks);
});

test('prompt manifests reject invalid blocks and each declared boundary', async t => {
  const tooManyBlocks = Array.from({ length: 33 }, () => block());
  const cases = [
    ['non-array blocks', null],
    ['more than 32 blocks', tooManyBlocks],
    ['empty name', [block({ name: '' })]],
    ['name longer than 80 characters', [block({ name: 'n'.repeat(81) })]],
    ['invalid source identifier', [block({ source: 'source with spaces' })]],
    ['source longer than 150 characters', [block({ source: 's'.repeat(151) })]],
    ['negative byte count', [block({ bytes: -1 })]],
    ['unsafe byte count', [block({ bytes: Number.MAX_SAFE_INTEGER + 1 })]],
    ['byte count above one billion', [block({ bytes: 1_000_000_001 })]],
    ['uppercase or malformed digest', [block({ sha256: 'A'.repeat(64) })]],
    ['invalid delivery value', [block({ delivery: 'partial' })]],
    ['missing block field', [{ name: 'Agent instructions', source: 'instructions', bytes: 24, sha256: 'a'.repeat(64) }]],
    ['unknown block field', [block({ promptText: 'must not be persisted' })]],
    ['array used as a block', [[ 'Agent instructions', 'instructions', 24, 'a'.repeat(64), 'full' ]]],
  ];

  for (const [label, blocks] of cases) {
    await t.test(label, () => {
      const { directory, journal } = fixture();
      const status = appendManifest(journal, blocks);
      assert.equal(status.availability, 'unavailable');
      assert.deepEqual(status.faults, ['journal_invalid_event']);
      assert.deepEqual(readRunJournal({ directory, identity }).records, []);
    });
  }
});

test('reader marks a persisted prompt manifest with invalid fields as corrupt', () => {
  const { directory, journal } = fixture();
  journal.append({ kind: 'attempt_started', turnId, attemptId });
  appendFileSync(join(directory, 'run-evidence.jsonl'), `${JSON.stringify({
    kind: 'prompt_manifest',
    turnId,
    attemptId,
    seq: 2,
    at: Date.now(),
    blocks: [block({ sha256: 'not-a-hash' })],
  })}\n`);

  const result = readRunJournal({ directory, identity });
  assert.equal(result.availability, 'corrupt');
  assert.deepEqual(result.records.map(record => record.kind), ['attempt_started']);
  assert.ok(result.faults.includes('journal_corrupt_record'));
});
