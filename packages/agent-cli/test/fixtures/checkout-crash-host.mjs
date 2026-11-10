// Disposable ownership fixture. No providers, credentials, model APIs or personal registry.
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { claimWorkerCheckout } from '../../src/checkout-ownership.mjs';
import { prepareSupervisedModel } from '../../src/model-guard.mjs';

const [mode, encoded] = process.argv.slice(2);
const options = JSON.parse(encoded);
const here = fileURLToPath(import.meta.url);
if (mode === 'native') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await writeFile(options.nativeEvidence, JSON.stringify({ nativePid: process.pid, descendantPid: child.pid }));
  setInterval(() => {}, 1000);
} else {
  const claim = await claimWorkerCheckout(options);
  if (options.phase !== 'idle') claim.beginTurn();
  let guard, native;
  if (options.phase === 'running') {
    guard = prepareSupervisedModel({ cwd: options.folder, env: { PATH: '/usr/bin:/bin' },
      deadline: Date.now() + 60000, stdio: ['ignore', 'pipe', 'pipe'] });
    process.send({ resources: true, guardPid: guard.pid });
    guard.stdout.resume(); guard.stderr.resume();
    claim.guardStarted(guard.pid);
    const observed = new Promise((resolve, reject) => {
      guard.once('error', reject);
      guard.on('message', value => {
        if (!value.nativeStarted) return;
        native = { pid: value.nativeStarted }; claim.nativeStarted(native.pid);
        process.send({ resources: true, nativePid: native.pid }); resolve();
      });
    });
    guard.authorize(process.execPath, [here, 'native', encoded]);
    await observed;
    for (let i = 0; i < 500; i++) {
      try { JSON.parse(await readFile(options.nativeEvidence, 'utf8')); break; }
      catch { await new Promise(resolve => setTimeout(resolve, 10)); }
    }
  }
  process.send({ ready: true, servicePid: process.pid, guardPid: guard?.pid ?? null,
    ...(native ? JSON.parse(await readFile(options.nativeEvidence, 'utf8')) : {}) });
  setInterval(() => {}, 1000);
}
