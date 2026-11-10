import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectEnvironment } from '../src/environment.mjs';

function fixture(run) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'k42-instructions-'))), home = join(root, 'home'), folder = join(root, 'repo');
  mkdirSync(join(home,'.claude'), { recursive:true }); mkdirSync(folder);
  try { return run({ root, folder, inspect:options => inspectEnvironment({ folder, userHome:home, env:{}, platform:'test', client:'claude', now:() => 123, ...options }) }); }
  finally { rmSync(root, { recursive:true, force:true }); }
}
test('symlinks, hard links and oversized instruction files are not read', () => fixture(({root,folder,inspect}) => {
  const secret = join(root,'secret.txt'); writeFileSync(secret,'do not follow this target');
  symlinkSync(secret,join(folder,'CLAUDE.md')); linkSync(secret,join(folder,'CLAUDE.local.md'));
  mkdirSync(join(folder,'nested')); writeFileSync(join(folder,'nested','CLAUDE.md'),'x'.repeat(128*1024+1));
  const value = inspect({includeContents:true});
  assert.equal(value.report.sources.find(s=>s.path===join(folder,'CLAUDE.md')).status,'unreadable');
  assert.equal(value.report.sources.find(s=>s.path===join(folder,'CLAUDE.local.md')).status,'unreadable');
  assert(!JSON.stringify(value).includes('do not follow this target'));
}));
