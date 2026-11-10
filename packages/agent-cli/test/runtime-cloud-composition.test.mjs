import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openRuntimeStore } from '../src/service/store.mjs';
import { createCloudRuntime } from '../src/service/cloud-runtime.mjs';
import { turnReportId } from '../src/service/cloud-reports.mjs';

const target = { site: 'https://synthetic.example', ownerId: 'owner', projectId: 'park', agentId: 'agent' };
const start = () => ({ version: 2, operationId: randomUUID(), kind: 'start', target, missionId: randomUUID(), payload: { scope: 'Synthetic cloud composition check', deadlineAt: Date.now() + 300000, execution: { provider: 'codex', model: null } } });
async function until(read, match) { for (let i = 0; i < 500; i++) { const value = await read(); if (match(value)) return value; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail('Synthetic composition did not settle'); }

test('trusted cloud composition starts once, saves and delivers evidence without cloud last_turn bypass; a service stop leaves the worker waiting', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mlswarm-cloud-composition-'));
  const store = await openRuntimeStore({ directory });
  let runtime;
  t.after(async () => { await runtime?.close(); await store.close(); await rm(directory, { recursive: true, force: true }); });
  const requests = []; let turns = 0;
  const fetchImpl = async (url, options) => {
    assert.ok(url.startsWith(`${target.site}/p/park/v2/`));
    assert.equal(options.headers.authorization, 'Bearer synthetic-park-only');
    const body = JSON.parse(options.body), path = new URL(url).pathname;
    requests.push({ path, body });
    let value;
    if (path.endsWith('/runs')) value = { protocol: 2, run_id: body.client_run_id, generation: 1, poll_seconds: 20 };
    else if (path.endsWith('/wait')) value = { project: { started: true, paused: false, closed: false }, pending: 0, acknowledged: 0 };
    else if (path.endsWith('/project-control')) {
      // Exercise the real held-control contract. Omitting this route makes the
      // controller correctly hold work on transport failure, racing this test.
      if (body.after_revision === 1) return new Promise((resolve, reject) => {
        if (options.signal.aborted) return reject(options.signal.reason);
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
      value = { project: { started: true, paused: false, closed: false, revision: 1 } };
    }
    else if (path.endsWith('/worker-session')) value = { missionId: body.missionId, messages: [], authorizedDeadlineAt: body.deadlineAt };
    else if (path.endsWith('/phase')) { assert.equal(body.last_turn, undefined); value = { ok: true, run_id: path.split('/').at(-2), phase: body.phase }; }
    else if (path.endsWith('/turn-reports')) value = { ok: true, report_id: turnReportId(target.agentId, body.run_id, body.last_turn.usage.sequence) };
    else assert.fail('Unexpected synthetic request');
    return Response.json(value);
  };
  runtime = createCloudRuntime({ store, cloudBindings: [{ target, url: `${target.site}/p/park`, token: 'synthetic-park-only', fetchImpl }], observeIntervalMs: 50, deliveryIntervalMs: 50,
    adapterFactory: async () => ({ async run(options) {
      turns++; await options.onPromptSubmitted(); await options.onTurnStarted();
      return { text: 'Synthetic finished.\nWORK_NEXT: waiting', delivery: 'acknowledged', failed: false, interrupted: false, retryable: false, cleanupConfirmed: true };
    } }),
  });
  const command = start();
  await runtime.controllers.accept(command);
  const query = { missionId: command.missionId, target };
  await until(() => store.getMission(query), value => value.outcomes.length === 1 && value.reportDelivery.delivered === 1);
  await runtime.close();
  const saved = await store.getMission(query);
  assert.equal(turns, 1);
  assert.ok(requests.some(item => item.path.endsWith('/project-control')), 'Current project-control contract was exercised');
  assert.equal(requests.filter(item => item.path.endsWith('/runs')).length, 1);
  // Waiting survives a connector restart (owner decision, 9 November 2026): a service stop does not end the run.
  assert.equal(saved.state, 'waiting');
  assert.deepEqual(saved.reportDelivery, { pending: 0, delivered: 1, attention: 0 });
  assert.equal(requests.filter(item => item.body.phase === 'stopping').length, 0);
});

test('reopening composition only drains original evidence and never registers or creates a model', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mlswarm-cloud-replay-'));
  let store = await openRuntimeStore({ directory }); let runtime;
  t.after(async () => { await runtime?.close(); await store.close(); await rm(directory, { recursive: true, force: true }); });
  const command = start(); const { mission } = await store.accept(command);
  await store.prepareCloudRun({ missionId: mission.missionId, generation: mission.generation, startedAt: mission.createdAt });
  await store.bindCloudRun({ missionId: mission.missionId, generation: mission.generation, runId: mission.missionId, cloudGeneration: 1 });
  const turnId = randomUUID();
  await store.prepareTurn({ missionId: mission.missionId, generation: mission.generation, turnId });
  await store.recordTurn({ missionId: mission.missionId, generation: mission.generation, turnId, text: 'Synthetic saved', startedAt: mission.createdAt, endedAt: mission.createdAt + 100,
    outcome: { delivery: 'acknowledged', failed: false, interrupted: false, retryable: false, cleanupConfirmed: false } });
  // Unconfirmed cleanup needs recovery; a worker between turns with confirmed cleanup would continue instead.
  await store.close(); store = await openRuntimeStore({ directory });
  let delivered = 0;
  runtime = createCloudRuntime({ store, cloudBindings: [{ target, url: `${target.site}/p/park`, token: 'synthetic-original-only', fetchImpl: async (url, options) => {
    assert.ok(url.endsWith('/turn-reports')); assert.equal(options.headers.authorization, 'Bearer synthetic-original-only');
    const body = JSON.parse(options.body); assert.equal(body.run_id, mission.missionId); delivered++;
    return Response.json({ ok: true, report_id: turnReportId(target.agentId, mission.missionId, 1) });
  } }], adapterFactory: () => assert.fail('Delivery restart must not resolve an adapter'), deliveryIntervalMs: 20 });
  await until(() => store.getMission({ missionId: mission.missionId, target }), value => value.reportDelivery.delivered === 1);
  assert.equal(delivered, 1);
  assert.equal((await store.getMission({ missionId: mission.missionId, target })).state, 'recovery_required');
});
