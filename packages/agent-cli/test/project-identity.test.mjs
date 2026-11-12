import test from 'node:test';
import assert from 'node:assert/strict';
import { projectIdentity } from '../src/project-identity.mjs';

const id = 'a'.repeat(64);
const folder = process.platform === 'win32' ? 'C:\\work' : '/work';

test('an empty query or fragment does not change the saved project URL', () => {
  const expected = `https://x.example/p/${id}`;
  for (const projectUrl of [expected, `${expected}/`, `${expected}?`, `${expected}#`, `${expected}/?`, `${expected}/?#`]) {
    assert.equal(projectIdentity({ projectUrl, folder }).projectUrl, expected, projectUrl);
  }
});
