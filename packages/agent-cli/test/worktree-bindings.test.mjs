import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, copyFileSync, rmSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { makeMixedNativeFixtures } from './fixtures/mixed-native-fixtures.mjs';
import { createNativeAdapterFactory } from '../src/service/native-bindings.mjs';
import { inspectWorkerCheckout } from '../src/checkout-ownership.mjs';

test('sibling worktrees admit both provider bindings and retain independent ownership (fake processes, no models)', { timeout: 15000 }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'minions-worktree-bindings-')));
  const fixtures = await makeMixedNativeFixtures(root, [['garden', 'claude'], ['garden', 'codex']]);
  const git = (folder, ...args) => execFileSync('git', ['-C', folder, ...args], { encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: fixtures.envSource.HOME, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();
  const base = fixtures.bindings[0].folder;
  for (const [key, value] of [['user.name', 'Worktree Test'], ['user.email', 'test@example.invalid'], ['commit.gpgsign', 'false']]) git(base, 'config', key, value);
  writeFileSync(join(base, 'README.md'), 'Synthetic base\n'); git(base, 'add', 'README.md'); git(base, 'commit', '-q', '-m', 'Initial');
  const baseHead = git(base, 'rev-parse', 'HEAD');
  for (const binding of fixtures.bindings) {
    const previous = binding.folder;
    binding.folder = join(root, `worktree-${binding.target.agentId}`);
    git(base, 'worktree', 'add', '-q', '-b', `codex/test-${binding.target.agentId}`, binding.folder, 'HEAD');
    copyFileSync(join(previous, '.mixed-native.json'), join(binding.folder, '.mixed-native.json'));
    assert.match(readFileSync(join(binding.folder, '.git'), 'utf8'), /^gitdir:/);
  }
  fixtures.registryRoot = join(root, 'claims');
  const factory = createNativeAdapterFactory(fixtures), adapters = [];
  t.after(async () => { for (const adapter of adapters) await adapter.release({ cleanupConfirmed: true }); rmSync(root, { recursive: true, force: true }); });
  for (const binding of fixtures.bindings) {
    const mission = { target: binding.target, missionId: randomUUID(), generation: 1, execution: { provider: binding.target.agentId, model: null }, scope: 'Synthetic worktree verification' };
    const adapter = await factory(mission); adapters.push(adapter);
    await assert.rejects(factory({ ...mission, missionId: randomUUID() }), /already owned/);
    const observation = inspectWorkerCheckout({ folder: binding.folder, agentId: binding.target.agentId, project: binding.target.projectId, registryRoot: fixtures.registryRoot });
    assert.equal(observation.exactClaims.length, 1); assert.equal(observation.overlappingOtherClaims, 0);
  }
  const results = await Promise.all(adapters.map(adapter => adapter.run({ prompt: 'Synthetic only', signal: new AbortController().signal, deadline: Date.now() + 8000 })));
  for (const result of results) { assert.equal(result.failed, false); assert.equal(result.cleanupConfirmed, true); }
  writeFileSync(join(fixtures.bindings[0].folder, 'claude-only.txt'), 'Independent edit\n');
  git(fixtures.bindings[0].folder, 'add', 'claude-only.txt'); git(fixtures.bindings[0].folder, 'commit', '-q', '-m', 'Worker change');
  assert.equal(git(fixtures.bindings[1].folder, 'rev-parse', 'HEAD'), baseHead);
  assert.equal(git(base, 'rev-parse', 'HEAD'), baseHead);
  for (const adapter of adapters) await adapter.release({ cleanupConfirmed: true });
  adapters.length = 0;
  for (const binding of fixtures.bindings) assert.equal(inspectWorkerCheckout({ folder: binding.folder, agentId: binding.target.agentId, project: binding.target.projectId, registryRoot: fixtures.registryRoot }).exactClaims.length, 0);
});
