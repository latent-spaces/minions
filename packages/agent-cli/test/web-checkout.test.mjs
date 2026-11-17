import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareWebCheckout } from '../src/service/web-agent-starts.mjs';

// Default agent folders are ~/minions/projects/... without resolving links. A linked ~/minions (another disk) or home
// parent must not make every website start fail; a linked checkout folder itself is still refused.
test('a website start reuses its prepared checkout through a linked parent, never through a linked folder', { skip: process.platform === 'win32' }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'minions-web-checkout-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = 'https://github.com/example/fixture', real = join(root, 'disk', 'minions'), folder = join(real, 'projects', 'p', 'agent-abc123');
  await mkdir(folder, { recursive: true });
  execFileSync('git', ['init', '-q', folder]);
  execFileSync('git', ['-C', folder, 'remote', 'add', 'origin', repo]);
  await symlink(real, join(root, 'minions'));
  const linked = join(root, 'minions', 'projects', 'p', 'agent-abc123');
  await prepareWebCheckout({ folder: linked, repo });
  await prepareWebCheckout({ folder, repo });
  await symlink(folder, join(root, 'agent-link'));
  await assert.rejects(prepareWebCheckout({ folder: join(root, 'agent-link'), repo }), { code: 'preparation_failed' });
  await symlink(join(root, 'missing'), join(root, 'dangling-link'));
  await assert.rejects(prepareWebCheckout({ folder: join(root, 'dangling-link'), repo }), { code: 'preparation_failed' });
  await assert.rejects(prepareWebCheckout({ folder: linked, repo: 'https://github.com/example/other' }), { code: 'preparation_failed' });
});
