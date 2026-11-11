import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { openRuntimeStore } from '../src/service/store.mjs';
import { createRuntimeControllers } from './fixtures/recorded-controllers.mjs';
import { createFakeAdapterFactory } from './fixtures/runtime-fake-adapter.mjs';
const target = { site: 'https://example.test', ownerId: 'synthetic-owner', projectId: 'synthetic-project', agentId: 'synthetic-agent' };
const fixture = fileURLToPath(new URL('./fixtures/runtime-fake-native.mjs', import.meta.url));
const start = (overrides = {}) => ({ version: 2, operationId: randomUUID(), kind: 'start', target, missionId: randomUUID(), payload: { scope: 'Synthetic contract test', deadlineAt: Date.now() + 30000, execution: { provider: 'claude', model: null } }, ...overrides });
const command = (mission, kind, payload = {}) => ({ version: 2, operationId: randomUUID(), kind, target: mission.target, missionId: mission.missionId, generation: mission.generation, payload });
async function until(read, predicate, label) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) { const value = await read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 15)); }
  assert.fail(`Timed out: ${label}`);
}
async function setup(t, input, wrap = store => store) {
  const directory = await mkdtemp(join(tmpdir(), 'mlswarm-fake-controller-'));
  const store = await openRuntimeStore({ directory: join(directory, 'state') });
  const events = join(directory, 'events.jsonl');
  const adapter = { command: process.execPath, args: [fixture], cwd: directory, env: { PATH: process.env.PATH }, initialInput: (mission, steering) => ({ events, steering, ...input?.(mission, steering, directory) }) };
  const controllers = createRuntimeControllers({ store: wrap(store), adapterFactory: createFakeAdapterFactory(adapter) });
  t.after(async () => { await controllers.close(); await store.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, events, store, controllers, adapter };
}
const inspect = (controllers, mission) => () => controllers.getMission({ missionId: mission.missionId, target: mission.target });
async function eventLines(path) { try { return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } }

test('stop bypasses blocked storage acceptance while conflicting reuse causes no side effects', async t => {
  let release; let blocked = false;
  const gate = new Promise(resolve => { release = resolve; });
  const ctx = await setup(t, (_mission, _steering, directory) => ({ gate: join(directory, 'never-opened') }), store => ({ ...store, async reserveSteering(value) { if (blocked) await gate; return store.reserveSteering(value); } }));
  const initial = start(); const { mission } = await ctx.controllers.accept(initial);
  await until(() => eventLines(ctx.events), lines => lines.length === 1, 'running fake');
  const nativePid = (await eventLines(ctx.events))[0].pid;
  await assert.rejects(ctx.controllers.accept({ ...command(mission, 'stop'), operationId: initial.operationId }), { code: 'conflict' });
  assert.doesNotThrow(() => process.kill(nativePid, 0));
  blocked = true;
  const steering = ctx.controllers.accept(command(mission, 'steer', { message: 'Queued behind artificial storage delay.' }));
  await new Promise(resolve => setTimeout(resolve, 20));
  const stopping = ctx.controllers.accept(command(mission, 'stop'));
  await until(async () => { try { process.kill(nativePid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } }, Boolean, 'immediate native cleanup');
  release(); await assert.rejects(steering); await stopping;
  await until(inspect(ctx.controllers, mission), value => value.state === 'stopped', 'durable stop');
});

test('a mission found between turns at startup continues after its leftovers are ended, and Stop ends it', async t => {
  const ctx = await setup(t);
  const accepted = await ctx.store.accept(start());
  let inspections = 0;
  const recovered = createRuntimeControllers({ store: ctx.store, adapterFactory: createFakeAdapterFactory(ctx.adapter),
    stopOrphanedMission: async () => { inspections++; } });
  t.after(() => recovered.close());
  const replay = await recovered.accept(start({ operationId: accepted.receipt.operationId, missionId: accepted.mission.missionId, payload: { scope: accepted.mission.scope, deadlineAt: accepted.mission.deadlineAt, execution: accepted.mission.execution } }));
  assert.equal(replay.created, false);
  // Waiting survives a connector restart (owner decision, 9 November 2026): the same mission continues.
  await until(() => eventLines(ctx.events), lines => lines.length === 1, 'the restored mission runs its turn');
  assert.equal(inspections, 1, 'the previous service\'s processes are ended by exact identity before the adapter starts');
  await recovered.accept(command(accepted.mission, 'stop'));
  await until(inspect(recovered, accepted.mission), value => value.state === 'stopped', 'Stop ends the restored mission');
});

test('service SIGKILL cleans native descendants; restart preserves receipts, outcomes and queued steering without a run', async t => {
  const { fork } = await import('node:child_process');
  const directory = await mkdtemp(join(tmpdir(), 'mlswarm-controller-crash-'));
  const host = fork(fileURLToPath(new URL('./fixtures/runtime-controller-host.mjs', import.meta.url)), [directory], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; host.stderr.on('data', data => { stderr += data; });
  const replies = new Map(); let ready;
  const readyPromise = new Promise(resolve => { ready = resolve; });
  host.on('message', message => { if (message.ready) ready(); else { const pending = replies.get(message.id); if (pending) { replies.delete(message.id); message.error ? pending.reject(new Error(message.error)) : pending.resolve(message.result); } } });
  const request = body => new Promise((resolve, reject) => { const id = randomUUID(); replies.set(id, { resolve, reject }); host.send({ id, ...body }); });
  t.after(async () => { if (host.exitCode === null && host.signalCode === null) { host.kill('SIGKILL'); await new Promise(resolve => host.once('exit', resolve)); } await rm(directory, { recursive: true, force: true }); });
  await readyPromise;
  const initial = start(); const { mission } = await request({ command: initial });
  const query = { missionId: mission.missionId, target };
  await until(() => request({ query }), value => value.outcomes.length === 1, 'durable first outcome');
  await request({ command: command(mission, 'steer', { message: 'Start a synthetic second turn.' }) });
  const childPid = await until(async () => { try { return Number(await readFile(join(directory, 'child.pid'), 'utf8')); } catch { return null; } }, Boolean, 'native descendant');
  const nativePid = (await eventLines(join(directory, 'events.jsonl')))[1].pid;
  const queued = command(mission, 'steer', { message: 'Keep this instruction queued across the crash.' });
  await request({ command: queued });
  const exited = new Promise(resolve => host.once('exit', resolve)); host.kill('SIGKILL'); await exited;
  const gone = pid => { try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } };
  await until(async () => gone(nativePid) && gone(childPid), Boolean, `native process tree cleanup (${stderr})`);
  const store = await openRuntimeStore({ directory: join(directory, 'state') });
  const controllers = createRuntimeControllers({ store, adapterFactory: createFakeAdapterFactory({ command: process.execPath, args: [fixture], cwd: directory, env: {}, initialInput: () => { assert.fail('Restart must not run'); } }) });
  try {
    const recovered = await controllers.getMission(query);
    assert.equal(recovered.state, 'recovery_required');
    assert.equal(recovered.outcomes[0].text, 'Synthetic first turn complete.');
    assert.equal(recovered.steering.find(item => item.operationId === queued.operationId).state, 'queued');
    assert.equal((await controllers.getOperation({ operationId: initial.operationId, target })).missionId, mission.missionId);
    assert.equal((await controllers.accept(initial)).created, false);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal((await eventLines(join(directory, 'events.jsonl'))).length, 2);
  } finally { await controllers.close(); await store.close(); }
});

test('external guard death retains uncertain cleanup and agent exclusivity', async t => {
  const ctx = await setup(t, (_mission, _steering, directory) => ({ gate: join(directory, 'never-opened'), childPidFile: join(directory, 'child.pid') }));
  const { mission } = await ctx.controllers.accept(start());
  await until(() => eventLines(ctx.events), lines => lines.length === 1, 'native fixture process');
  const nativePid = (await eventLines(ctx.events))[0].pid;
  // These PIDs belong only to the fake process tree created by this test.
  t.after(() => { try { process.kill(-nativePid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } });
  const childPid = await until(async () => { try { return Number(await readFile(join(ctx.directory, 'child.pid'), 'utf8')); } catch { return null; } }, Boolean, 'native fixture child');
  const running = await inspect(ctx.controllers, mission)();
  process.kill(running.guardPid, 'SIGKILL');
  const uncertain = await until(inspect(ctx.controllers, mission), value => value.state === 'recovery_required', 'uncertain cleanup record');
  assert.equal(uncertain.guardPid, running.guardPid);
  assert.doesNotThrow(() => process.kill(nativePid, 0));
  assert.doesNotThrow(() => process.kill(childPid, 0));
  await assert.rejects(ctx.controllers.accept(start()), { code: 'conflict' });
  await ctx.controllers.accept(command(mission, 'stop'));
  assert.equal((await inspect(ctx.controllers, mission)()).state, 'recovery_required');
  await assert.rejects(ctx.controllers.accept(start()), { code: 'conflict' });
  process.kill(-nativePid, 'SIGKILL');
  await until(async () => { try { process.kill(nativePid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } }, Boolean, 'known fixture cleanup');
});
