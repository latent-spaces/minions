import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openRuntimeStore } from '../src/service/store.mjs';

const target = { site: 'https://fixture.invalid', ownerId: 'synthetic-owner', projectId: 'synthetic-project', agentId: 'synthetic-agent' };
const start = overrides => ({ version: 2, operationId: randomUUID(), kind: 'start', target, missionId: randomUUID(), payload: { scope: 'Synthetic work only', deadlineAt: Date.now() + 60000, execution: { provider: 'codex', model: null } }, ...overrides });
const rejects = (promise, code) => assert.rejects(promise, error => error.code === code);

test('a killed service leaves durable evidence; a mission between turns survives and one mid-turn needs recovery', { timeout: 10000 }, async t => {
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const directory = await mkdtemp(join(tmpdir(), 'mlswarm-store-crash-'));
  const input = start(), working = start({ target: { ...target, agentId: 'synthetic-working' } }), turnId = randomUUID();
  const script = `import {openRuntimeStore} from ${JSON.stringify(new URL('../src/service/store.mjs', import.meta.url).href)}; const s=await openRuntimeStore({directory:process.argv[2]}); const result=await s.accept(JSON.parse(process.argv[3])); const busy=await s.accept(JSON.parse(process.argv[4])); await s.prepareTurn({missionId:busy.mission.missionId,generation:1,turnId:process.argv[5]}); process.send(result);`;
  const scriptPath = join(directory, 'fixture.mjs'); await writeFile(scriptPath, script);
  const child = spawn(process.execPath, [scriptPath, directory, JSON.stringify(input), JSON.stringify(working), turnId], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await rm(directory, { recursive: true, force: true }); });
  const [accepted] = await once(child, 'message');
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  const reopened = await openRuntimeStore({ directory });
  try {
    assert.deepEqual(await reopened.getOperation({ operationId: input.operationId, target }), accepted.receipt);
    // Waiting survives a connector restart (owner decision, 9 November 2026); interrupted work is never resumed silently.
    assert.equal((await reopened.getMission(accepted.mission)).state, 'accepted');
    const interrupted = await reopened.getMission({ missionId: working.missionId, target: working.target });
    assert.equal(interrupted.state, 'recovery_required'); assert.equal(interrupted.currentTurnId, turnId);
    assert.equal((await reopened.accept(input)).created, false);
  } finally { await reopened.close(); }
});

test('a stalled storage request reopens storage in place without interrupting missions', { timeout: 15000 }, async t => {
  const { DatabaseSync } = await import('node:sqlite');
  const directory = await mkdtemp(join(tmpdir(), 'mlswarm-store-stall-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const lines = [];
  const store = await openRuntimeStore({ directory, requestTimeoutMs: 300, reopenDelayMs: 50, log: line => lines.push(line) });
  try {
    const accepted = await store.accept(start());
    const before = (await store.getMission(accepted.mission)).state;
    // Another connection holds the write lock past the request deadline.
    const blocker = new DatabaseSync(join(directory, 'runtime.sqlite'));
    blocker.exec('BEGIN IMMEDIATE');
    await rejects(store.accept(start({ target: { ...target, agentId: 'synthetic-agent-2' } })), 'storage_timeout');
    await rejects(store.health(), 'storage_timeout');
    blocker.exec('ROLLBACK'); blocker.close();
    let health;
    for (let tries = 0; !health && tries < 200; tries++) {
      health = await store.health().catch(() => null);
      if (!health) await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(health?.ready, true);
    assert.equal((await store.getMission(accepted.mission)).state, before);
    assert.ok(lines.some(line => line.includes('storage_timeout')) && lines.includes('Storage reopened.'));
    assert.equal((await store.accept(start({ target: { ...target, agentId: 'synthetic-agent-3' } }))).created, true);
  } finally { await store.close(); }
});

test('future, incompatible and corrupt databases are refused without replacing their contents', async t => {
  const { DatabaseSync } = await import('node:sqlite');
  const { readFile } = await import('node:fs/promises');
  for (const version of [0, 1, 4, 5, 99]) {
    const directory = await mkdtemp(join(tmpdir(), 'mlswarm-store-schema-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const database = join(directory, 'runtime.sqlite'); const db = new DatabaseSync(database);
    db.exec(`CREATE TABLE preserved(evidence TEXT); INSERT INTO preserved VALUES('must survive'); PRAGMA user_version=${version}`); db.close();
    await rejects(openRuntimeStore({ directory }), 'unsupported_schema');
    const check = new DatabaseSync(database);
    assert.equal(check.prepare('PRAGMA user_version').get().user_version, version);
    assert.equal(check.prepare('SELECT evidence FROM preserved').get().evidence, 'must survive'); check.close();
  }
  const directory = await mkdtemp(join(tmpdir(), 'mlswarm-store-corrupt-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const database = join(directory, 'runtime.sqlite'); const evidence = Buffer.from('synthetic corrupt database; preserve this evidence');
  await writeFile(database, evidence);
  await rejects(openRuntimeStore({ directory }), 'storage_failure');
  assert.deepEqual(await readFile(database), evidence);
});
