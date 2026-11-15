import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, realpathSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createCodexMergePolicy } from '../src/codex-merge-policy.mjs';
import { agentsMayMerge, codexMergeRules, workerClaudeSettings } from '../runtime/providers.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'minions-native-rules-'))), folder = join(root, 'checkout with spaces'), stateDir = join(root, 'state');
  mkdirSync(folder); mkdirSync(stateDir, { mode: 0o700 }); execFileSync('git', ['-C', folder, 'init', '--quiet']);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { folder, stateDir, policy: createCodexMergePolicy({ folder, stateDir }) };
}
test('one policy decision compiles both native clients without changing other restrictions', () => {
  const bundled = JSON.stringify({ permissions: { deny: ['Bash(gh pr merge)', 'Bash(gh pr merge *)', 'Bash(git merge *)', 'Bash(npm publish *)'] } });
  for (const mode of ['humans', 'other_agents', 'agent_review', 'anyone']) {
    assert.equal(agentsMayMerge(mode), mode !== 'humans');
    assert.equal(codexMergeRules(mode).includes('forbidden'), mode === 'humans');
    // Like the bundled Claude deny rules, a human-merge Codex worker cannot merge locally either.
    for (const command of ['merge', 'pull']) assert.equal(codexMergeRules(mode).includes(`pattern = ["git", "${command}"], decision = "forbidden"`), mode === 'humans');
    assert.equal(workerClaudeSettings(bundled, mode).permissions.deny.includes('Bash(gh pr merge *)'), mode === 'humans');
    assert.equal(workerClaudeSettings(bundled, mode).permissions.deny.includes('Bash(gh pr merge)'), mode === 'humans');
    assert.ok(workerClaudeSettings(bundled, mode).permissions.deny.includes('Bash(npm publish *)'));
  }
});
test('native rule refresh preserves project config and rules and is excluded from git add-all', async t => {
  const f = fixture(t); mkdirSync(join(f.folder, '.codex')); mkdirSync(join(f.folder, '.codex', 'rules'));
  const config = join(f.folder, '.codex', 'config.toml'), personal = join(f.folder, '.codex', 'rules', 'existing.rules');
  writeFileSync(config, '# Existing project config\n'); writeFileSync(personal, '# Existing native rule\n');
  await f.policy.prepare(codexMergeRules('humans')); assert.match(readFileSync(f.policy.file, 'utf8'), /forbidden/);
  execFileSync('git', ['-C', f.folder, 'add', '--all']);
  assert.doesNotMatch(execFileSync('git', ['-C', f.folder, 'diff', '--cached', '--name-only'], { encoding: 'utf8' }), /minions-worker-merge/);
  await f.policy.prepare(codexMergeRules('other_agents')); assert.doesNotMatch(readFileSync(f.policy.file, 'utf8'), /forbidden/);
  await f.policy.cleanup(); assert.equal(existsSync(f.policy.file), false);
  assert.equal(readFileSync(config, 'utf8'), '# Existing project config\n'); assert.equal(readFileSync(personal, 'utf8'), '# Existing native rule\n');
});
test('unowned or changed rule files are preserved and cannot silently replace the required native policy', async t => {
  const f = fixture(t); await f.policy.prepare(codexMergeRules('humans'));
  writeFileSync(f.policy.file, '# Changed by its owner\n', { mode: 0o600 });
  await assert.rejects(f.policy.prepare(codexMergeRules('anyone')), /could not be installed safely/);
  await assert.rejects(f.policy.cleanup(), /could not be installed safely/);
  assert.equal(readFileSync(f.policy.file, 'utf8'), '# Changed by its owner\n');
});
test('a crash receipt permits safe same-mission recovery and removes only generated empty directories', async t => {
  const f = fixture(t); await f.policy.prepare(codexMergeRules('humans'));
  const recovered = createCodexMergePolicy(f); await recovered.prepare(codexMergeRules('anyone')); await recovered.cleanup();
  assert.equal(existsSync(join(f.folder, '.codex')), false);
  assert.equal(existsSync(join(f.stateDir, 'codex-merge-policy.json')), false);
});
test('symlinked project configuration is refused without changing its target', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t), outside = join(f.stateDir, 'outside'); mkdirSync(outside); symlinkSync(outside, join(f.folder, '.codex'));
  await assert.rejects(f.policy.prepare(codexMergeRules('humans')), /could not be installed safely/);
  assert.equal(existsSync(join(outside, 'rules')), false);
});
test('cleanup refuses replaced ancestors and never removes a matching file outside the checkout', { skip: process.platform === 'win32' }, async t => {
  const f=fixture(t);await f.policy.prepare(codexMergeRules('humans'));
  const outside=join(f.stateDir,'moved');renameSync(join(f.folder,'.codex'),outside);symlinkSync(outside,join(f.folder,'.codex'));
  await assert.rejects(f.policy.cleanup(),/could not be installed safely/);
  assert.equal(existsSync(join(outside,'rules','minions-worker-merge.rules')),true);
});
test('a non-root work directory is refused before generating any native files',async t=>{
  const f=fixture(t),child=join(f.folder,'subdirectory');mkdirSync(child);
  await assert.rejects(createCodexMergePolicy({folder:child,stateDir:f.stateDir}).prepare(codexMergeRules('humans')),/could not be installed safely/);
  assert.equal(existsSync(join(child,'.codex')),false);
});
