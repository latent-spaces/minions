// The minions command loads, answers help and status in plain lines when piped, and refuses unknown commands.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../minions.mjs', import.meta.url));

async function freePort() {
  const server = createServer();
  await new Promise(accept => server.listen(0, '127.0.0.1', accept));
  const { port } = server.address();
  await new Promise(accept => server.close(accept));
  return port;
}

test('minions answers help, reports an empty installation and refuses an unknown command', async () => {
  const home = mkdtempSync(join(tmpdir(), 'minions cli '));
  try {
    const env = { ...process.env, MINIONS_ENGINE_HOME: join(home, 'engine'), MINIONS_ENGINE_PORT: String(await freePort()), MINIONS_NO_BROWSER: '1' };
    const minions = (...args) => spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8', windowsHide: true });
    const help = minions('help');
    assert.equal(help.status, 0);
    assert.match(help.stdout, /start \[--open\]/);
    const status = minions('status', '--json');
    assert.equal(status.status, 0);
    const value = JSON.parse(status.stdout);
    assert.equal(value.engine, 'free');
    assert.equal(value.initialized, 'new');
    assert.equal(value.service.running, false);
    const doctor = minions('doctor', '--json');
    assert.equal(doctor.status, 1);
    const report = JSON.parse(doctor.stdout);
    assert.equal(report.healthy, false);
    assert.ok(report.checks.some(check => check.name === 'Engine setup' && !check.ok));
    assert.match(help.stdout, /doctor \[--json\]/);
    const unknown = minions('dance');
    assert.equal(unknown.status, 2);
    assert.match(unknown.stdout, /Unknown command: dance/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('followed logs preserve UTF-8 across initial and later reads, and reset after truncation', { timeout: 15_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'minions log '));
  const file = join(home, 'engine.log');
  const character = Buffer.from('🛠');
  let child;
  let closed;
  let output = '', errors = '';
  try {
    writeFileSync(file, Buffer.concat([Buffer.from('discard\nready\r\npartial:'), character.subarray(0, 2)]));
    child = spawn(process.execPath, [script, 'logs', '--follow', '--lines', '2'], {
      env: { ...process.env, MINIONS_ENGINE_HOME: home, MINIONS_ENGINE_PORT: String(await freePort()), MINIONS_NO_BROWSER: '1' },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    closed = new Promise((accept, reject) => { child.once('close', accept); child.once('error', reject); });
    child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { errors += chunk; });
    const until = async text => {
      const deadline = Date.now() + 4_000;
      while (!output.includes(text)) {
        assert.equal(child.exitCode, null, errors);
        assert.ok(Date.now() < deadline, `Missing ${JSON.stringify(text)} in ${JSON.stringify(output)}; ${errors}`);
        await new Promise(accept => setTimeout(accept, 10));
      }
    };
    await until('partial:');
    appendFileSync(file, Buffer.concat([character.subarray(2), Buffer.from(' initial\n')]));
    await until('🛠 initial\n');
    assert.equal(output.slice(output.indexOf('\n') + 1), 'ready\r\npartial:🛠 initial\n');

    // The marker proves a poll consumed the incomplete character before the rest is appended.
    appendFileSync(file, Buffer.concat([Buffer.from('poll marker:'), character.subarray(0, 2)]));
    await until('poll marker:');
    appendFileSync(file, Buffer.concat([character.subarray(2), Buffer.from(' appended\n')]));
    await until('🛠 appended\n');

    const marker = `truncate marker:${'x'.repeat(100)}`;
    appendFileSync(file, Buffer.concat([Buffer.from(marker), character.subarray(0, 2)]));
    await until(marker);
    writeFileSync(file, 'fresh 🛠\n'); // Shorter than the previous size: a new UTF-8 stream.
    await until('fresh 🛠\n');
    assert.doesNotMatch(output, /\uFFFD/);
    assert.equal(errors, '');
  } finally {
    try {
      if (child && child.exitCode === null && child.signalCode === null) child.kill();
      if (closed) {
        let timer;
        try { await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Log follower did not stop.')); }, 2_000); })]); }
        finally { clearTimeout(timer); }
      }
    } finally { rmSync(home, { recursive: true, force: true }); }
  }
});
