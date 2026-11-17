import test from 'node:test';
import assert from 'node:assert/strict';
import { BUNDLED_SKILL, bundledGuideFiles, referenceHash } from '../src/skill-bundle.mjs';

// Setup installs the skill straight from a checkout, which need not be built. A stale digest makes
// every fresh install read as changed by the person, so later setups never update it.
test('the committed skill router declares the digest of its bundled references', () => {
  assert.equal(BUNDLED_SKILL.references_sha256, referenceHash(bundledGuideFiles()),
    'Run the connector build to refresh references-sha256 in skills/minions/SKILL.md.');
});
