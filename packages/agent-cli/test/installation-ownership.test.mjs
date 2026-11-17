import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureInstallation, runInstalledService } from '../src/service/installation.mjs';

// After a crash the ownership record stays; a restart can hand its PID to another program. Start never takes
// such a record over, but says which file to remove once service-status shows no service.
test('a running process named by a leftover ownership record blocks start, naming the record to remove', async t => {
  const root = await mkdtemp(join(tmpdir(), 'minions-owner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'service'), site = 'http://127.0.0.1:18787';
  await mkdir(home, { mode: 0o700 });
  await ensureInstallation({ home, site });
  const record = join(home, 'service-owner.json');
  await writeFile(record, JSON.stringify({ version: 1, pid: process.pid, nonce: 'left-by-a-crash' }), { mode: 0o600 });
  let composed = false;
  await assert.rejects(runInstalledService({ home, site, compose: async () => { composed = true; throw new Error('not reached'); } }),
    error => error.message.includes(`Process ${process.pid} is recorded`) && error.message.includes(record)
      && /still starting or stopping/.test(error.message) && /is not a Minions service/.test(error.message) && /No process was stopped/.test(error.message));
  assert.equal(composed, false);
  assert.equal(JSON.parse(await readFile(record, 'utf8')).nonce, 'left-by-a-crash');
});

test('a second start while the service is still starting is refused with the wait advice, and the record stays', async t => {
  const root = await mkdtemp(join(tmpdir(), 'minions-owner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'service'), site = 'http://127.0.0.1:18787', record = join(home, 'service-owner.json');
  await mkdir(home, { mode: 0o700 });
  let finishCompose, composing;
  const started = new Promise(resolve => { composing = resolve; });
  const first = runInstalledService({ home, site, compose: () => { composing(); return new Promise((_resolve, reject) => { finishCompose = reject; }); } });
  await started;
  const owner = JSON.parse(await readFile(record, 'utf8'));
  await assert.rejects(runInstalledService({ home, site, compose: async () => { throw new Error('not reached'); } }),
    error => /still starting or stopping/.test(error.message) && /retry/.test(error.message));
  assert.equal(JSON.parse(await readFile(record, 'utf8')).nonce, owner.nonce);
  finishCompose(new Error('stop composing'));
  await assert.rejects(first, /stop composing/);
  await assert.rejects(readFile(record), { code: 'ENOENT' });
});
