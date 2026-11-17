import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { claimWorkerCheckout, inspectWorkerCheckout } from '../src/checkout-ownership.mjs';

// Claims are written under the registry's physical path; inspection must find them through the same
// spelling when a parent is a link (/tmp on macOS, /home on Fedora Atomic), or orphan Stop always refuses.
test('inspection sees a claim made through a linked parent, and refuses a linked registry', { skip: process.platform === 'win32' }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'minions-ownership-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const real = join(root, 'real'), linked = join(root, 'linked'), folder = join(root, 'checkout');
  await mkdir(real, { mode: 0o700 }); await mkdir(folder); await symlink(real, linked);
  const worker = { folder, agentId: 'agent', project: 'project', registryRoot: join(linked, 'registry') };
  const claim = await claimWorkerCheckout(worker);
  const seen = inspectWorkerCheckout(worker);
  assert.equal(seen.status, 'observed', JSON.stringify(seen.reasons));
  assert.equal(seen.exactClaims.length, 1);
  assert.equal(inspectWorkerCheckout({ ...worker, registryRoot: join(real, 'registry') }).exactClaims.length, 1);

  await symlink(join(real, 'registry'), join(root, 'registry-link'));
  assert.equal(inspectWorkerCheckout({ ...worker, registryRoot: join(root, 'registry-link') }).status, 'uncertain');
  assert.equal(inspectWorkerCheckout({ ...worker, registryRoot: join(root, 'missing', 'registry') }).status, 'missing');
  claim.release();
});
