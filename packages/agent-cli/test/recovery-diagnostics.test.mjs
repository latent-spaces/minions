import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectWorkerCheckout } from '../src/checkout-ownership.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mlswarm-inspection-'))), folder = join(root, 'checkout'), registryRoot = join(root, 'ownership');
  mkdirSync(folder, { mode: 0o700 }); mkdirSync(registryRoot, { mode: 0o700 });
  t.after(() => rmSync(root, { force: true, recursive: true }));
  return { root, folder, registryRoot, agentId: 'own-agent', project: 'own-project' };
}

test('symlink registry and nonprivate registry refuse without exposing contents', t => {
  const ctx = fixture(t), alias = join(ctx.root, 'alias'); symlinkSync(ctx.registryRoot, alias);
  assert.equal(inspectWorkerCheckout({ ...ctx, registryRoot: alias }).status, 'uncertain');
  chmodSync(ctx.registryRoot, 0o755);
  assert.equal(inspectWorkerCheckout(ctx).status, 'uncertain');
});
