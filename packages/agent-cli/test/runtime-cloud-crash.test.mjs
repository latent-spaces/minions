import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { openSync, writeFileSync, fsyncSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openRuntimeStore } from '../src/service/store.mjs';
import { createReportDelivery } from '../src/service/report-delivery.mjs';

const host = fileURLToPath(new URL('./fixtures/runtime-cloud-crash-host.mjs', import.meta.url));

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'minions-cloud-crash-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
function childStage(child, stage) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error(`Missing child stage: ${stage}`)), 10000);
    const message = value => { if (value.stage === stage) finish(null, value); };
    const exit = (code, signal) => finish(new Error(`Child exited before ${stage}: ${code}/${signal}`));
    const finish = (error, value) => { clearTimeout(timeout); child.off('message', message); child.off('exit', exit); error ? reject(error) : resolve(value); };
    child.on('message', message); child.once('exit', exit);
  });
}
async function kill(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
}
async function receiptServer(t, directory, loseFirstResponse) {
  const accepted = new Map(), attempts = [], file = join(directory, 'synthetic-receipts.json');
  const server = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const entry = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      attempts.push(entry);
      const previous = accepted.get(entry.reportId);
      if (previous) assert.deepEqual(entry.payload, previous.payload, 'a retry must not regenerate evidence');
      else {
        accepted.set(entry.reportId, entry);
        const fd = openSync(file, 'w', 0o600);
        try { writeFileSync(fd, JSON.stringify([...accepted])); fsyncSync(fd); } finally { closeSync(fd); }
      }
      if (loseFirstResponse && attempts.length === 1) { request.socket.destroy(); return; }
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ receiptId: entry.expectedReceiptId }));
    } catch (error) { response.writeHead(500); response.end(error.message); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { url: `http://127.0.0.1:${server.address().port}`, accepted, attempts };
}

for (const mode of ['local_commit', 'lost_response', 'before_ack', 'after_ack']) {
  test(`SIGKILL at ${mode} preserves one report and restart delivery never launches a model`, { timeout: 15000 }, async t => {
    const directory = await fixture(t), peer = await receiptServer(t, directory, mode === 'lost_response');
    const child = spawn(process.execPath, [host, directory, mode, peer.url], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
    t.after(() => kill(child));
    let local;
    try {
      const committed = childStage(child, 'local_commit');
      const boundary = mode === 'local_commit' ? committed : childStage(child, mode);
      [local] = await Promise.all([committed, boundary]);
    } catch (error) { throw new Error(`${error.message}\n${stderr}`); }
    await kill(child);
    const store = await openRuntimeStore({ directory: join(directory, 'state') });
    t.after(() => store.close());
    const mission = await store.getMission({ missionId: local.missionId, target: local.target });
    // The saved turn ended with confirmed cleanup, so the worker waits between turns after the crash.
    assert.equal(mission.state, 'waiting');
    assert.equal(mission.outcomes.length, 1); assert.equal(mission.outcomes[0].text, 'Saved synthetic result');
    const before = (await store.listReports({ missionId: local.missionId })).reports;
    assert.equal(before.length, 1); assert.equal(before[0].state, mode === 'after_ack' ? 'delivered' : 'pending');
    // The reopened delivery composition has no controller, adapter or native executable.
    const delivery = createReportDelivery({ store, intervalMs: 60000, send: async entry => {
      const response = await fetch(peer.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(entry) });
      return response.json();
    } });
    t.after(() => delivery.close()); await delivery.drain();
    const after = (await store.listReports({ missionId: local.missionId })).reports;
    assert.equal(after[0].state, 'delivered'); assert.equal(peer.accepted.size, 1);
    assert.equal(peer.attempts.length, ['lost_response', 'before_ack'].includes(mode) ? 2 : 1);
    assert.deepEqual(after[0].payload, before[0].payload); assert.equal(after[0].reportId, before[0].reportId);
    assert.equal((await store.getMission({ missionId: local.missionId, target: local.target })).outcomes.length, 1);
  });
}
