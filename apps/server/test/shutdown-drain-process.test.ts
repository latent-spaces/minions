import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { inProject } from '../src/firestore.js';
import { startRun } from '../src/v2/runs.js';
import { resetEmulator, seed, TEST_PROJECT } from './helpers.js';

// A real-process drill of the shutdown drain: the test API process (test/api-process.ts) receives SIGTERM while an
// agent holds project control. The hold must answer with the current state before the process exits, not be
// reset by it (c6-waves-recovery.md §2).
const serverDir = fileURLToPath(new URL('..', import.meta.url));
const tsx = createRequire(new URL('../package.json', import.meta.url)).resolve('tsx');
let child: ChildProcess | undefined;
afterEach(() => { if (child && child.exitCode === null) child.kill('SIGKILL'); child = undefined; });

const freePort = () => new Promise<number>((resolve, reject) => {
  const listener = createServer(); listener.once('error', reject);
  listener.listen(0, '127.0.0.1', () => { const { port } = listener.address() as { port: number }; listener.close(() => resolve(port)); });
});

test('SIGTERM answers a held project-control request with the current state, then the server exits cleanly', async () => {
  await resetEmulator();
  const { agents: [agent] } = await seed({ profiles: [{ name: 'Owner', email: 'drain-drill@example.test' }], agents: [{ person: 0, name: 'Runner' }] });
  const run = await inProject(TEST_PROJECT, () => startRun(agent.agentId, { clientRunId: randomUUID(), runnerVersion: 'synthetic', takeover: false }, Date.now));
  const port = await freePort();
  child = spawn(process.execPath, ['--import', tsx, 'test/api-process.ts'], { cwd: serverDir, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise<number | null>(resolve => child!.once('exit', code => resolve(code)));
  await new Promise<void>((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new Error(`Server did not start: ${text.slice(-500)}`)), 30_000);
    const seen = (chunk: Buffer) => { text += chunk; if (text.includes('Listening on')) { clearTimeout(timer); resolve(); } };
    child!.stdout!.on('data', seen); child!.stderr!.on('data', chunk => { text += chunk; });
  });
  const control = (body: object) => fetch(`http://127.0.0.1:${port}/p/${TEST_PROJECT}/v2/project-control`, { method: 'POST',
    headers: { authorization: `Bearer ${agent.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const first = await control({ run_id: run.run_id });
  expect(first.status).toBe(200);
  const { project } = await first.json() as { project: { revision: number } };
  const began = Date.now();
  const held = control({ run_id: run.run_id, after_revision: project.revision });
  // Long enough for the hold to pass its first run check and join the listener; well short of the 25 s hold.
  await new Promise(resolve => setTimeout(resolve, 1_500));
  child.kill('SIGTERM');
  const answer = await held;
  // Without the drain this request would end in a reset when the process exits 5 s after SIGTERM.
  expect(answer.status).toBe(200);
  expect(await answer.json()).toMatchObject({ project: { revision: project.revision, paused: false } });
  expect(Date.now() - began).toBeLessThan(1_500 + 4_000);
  expect(await exited).toBe(0);
}, 60_000);
