import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { readPrivate, writePrivate } from '../src/state.mjs';

test('replacement retries remain bounded and reject unsafe replacement storage', t => {
  const root = fs.mkdtempSync(join(tmpdir(), 'mlswarm-private-read-')), path = join(root, 'record.json');
  const originalStat = fs.fstatSync; let attempts = 0;
  try {
    writePrivate(path, { revision: 0 });
    t.mock.method(fs, 'fstatSync', fd => { writePrivate(path, { revision: ++attempts }); return originalStat(fd); });
    syncBuiltinESMExports();
    assert.throws(() => readPrivate(path, true), /private regular files/); assert.equal(attempts, 3);
    t.mock.restoreAll(); syncBuiltinESMExports();
    t.mock.method(fs, 'fstatSync', fd => {
      if (attempts++ === 3) { writePrivate(path, { revision: 4 }); fs.chmodSync(path, 0o644); }
      return originalStat(fd);
    });
    syncBuiltinESMExports();
    assert.throws(() => readPrivate(path, true), /private regular files/);
    t.mock.restoreAll(); syncBuiltinESMExports(); fs.chmodSync(path, 0o600);
    const alias = join(root, 'alias'); fs.linkSync(path, alias);
    assert.throws(() => readPrivate(path, true), /private regular files/);
    fs.unlinkSync(alias); fs.symlinkSync(path, alias);
    assert.throws(() => readPrivate(alias, true));
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); fs.rmSync(root, { recursive: true, force: true }); }
});
