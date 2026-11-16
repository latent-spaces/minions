import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { brandedDirectory, ownershipDirectory } from '../src/brand-paths.mjs';

test('fresh installations use Minions paths on Windows and POSIX', () => {
  for (const [paths, home] of [[path.posix, '/Users/ana'], [path.win32, 'C:\\Users\\Ana Lee']]) {
    assert.equal(brandedDirectory(home, { paths, exists: () => false }), paths.join(home, '.minions'));
    assert.equal(brandedDirectory(home, { paths, privateState: false, exists: () => false }), paths.join(home, 'minions'));
  }
});

test('existing installations retain saved state and checkout paths without moving files', () => {
  for (const [paths, home] of [[path.posix, '/Users/ana'], [path.win32, 'C:\\Users\\Ana Lee']]) {
    for (const privateState of [true, false]) {
      const previous = paths.join(home, privateState ? '.mlswarm' : 'mlswarm');
      const current = paths.join(home, privateState ? '.minions' : 'minions');
      assert.equal(brandedDirectory(home, { paths, privateState, exists: candidate => candidate === previous }), previous);
      assert.equal(brandedDirectory(home, { paths, privateState, exists: () => true }), current);
    }
  }
});

test('old and new workers arbitrate against the existing ownership ledger', () => {
  const home = '/Users/ana', previous = path.join(home, '.mlswarm', 'worker-ownership');
  assert.equal(ownershipDirectory(home, { exists: () => true }), previous);
  assert.equal(ownershipDirectory(home, { exists: candidate => candidate === previous }), previous);
  assert.equal(ownershipDirectory(home, { exists: () => false }), path.join(home, '.minions', 'worker-ownership'));
});
