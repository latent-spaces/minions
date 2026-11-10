import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openRuntimeStore } from '../src/service/store.mjs';

const target = { site: 'https://example.test', ownerId: 'owner', projectId: 'project', agentId: 'agent' };
const command = (agentId = target.agentId) => ({ version: 2, kind: 'start', operationId: randomUUID(), missionId: randomUUID(),
  target: { ...target, agentId }, payload: { scope: 'Synthetic capacity check', deadlineAt: Date.now() + 600000,
    execution: { provider: 'codex', model: null } } });

async function fixture(t, state, count, spread = false) {
  const directory = await mkdtemp(join(tmpdir(), 'mlswarm-report-capacity-'));
  let store = await openRuntimeStore({ directory });
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  const start = command();
  const { mission } = await store.accept(start);
  const ref = { missionId: mission.missionId, generation: mission.generation };
  await store.prepareCloudRun({ ...ref, startedAt: 1000 });
  await store.bindCloudRun({ ...ref, runId: ref.missionId, cloudGeneration: 1 });
  const turnId = randomUUID();
  await store.prepareTurn({ ...ref, turnId });
  await store.recordTurn({ ...ref, turnId, text: 'Synthetic saved outcome', startedAt: 1000, endedAt: 2000,
    outcome: { delivery: 'acknowledged', failed: false, interrupted: false, retryable: false, cleanupConfirmed: true } });
  const template = (await store.listReports({ missionId: ref.missionId })).reports[0];
  await store.acknowledgeReport({ reportId: template.reportId, receiptId: template.expectedReceiptId });
  await store.close();
  // Seed an offline synthetic database only; never write behind the live owner.
  const db = new DatabaseSync(join(directory, 'runtime.sqlite'));
  const columns = db.prepare('PRAGMA table_info(reports)').all().map(row => row.name);
  const original = db.prepare('SELECT * FROM reports WHERE reportId=?').get(template.reportId);
  const insert = db.prepare(`INSERT INTO reports(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`);
  db.exec('BEGIN');
  for (let i = 0; i < count; i++) {
    const id = createHash('sha256').update(`synthetic-${i}`).digest('hex');
    const row = { ...original, reportId: id, expectedReceiptId: id, state };
    if (spread) {
      const owner = { ...target, agentId: `other-${i}` };
      row.target = JSON.stringify(owner);
      row.targetKey = JSON.stringify([owner.site, owner.ownerId, owner.projectId, owner.agentId]);
    }
    insert.run(...columns.map(column => row[column]));
  }
  db.exec('COMMIT'); db.close();
  store = await openRuntimeStore({ directory });
  return { store, ref, template };
}

test('delivered history beyond 4096 is preserved and does not block new work', async t => {
  const f = await fixture(t, 'delivered', 4200);
  const first = await f.store.listReports({ missionId: f.ref.missionId, limit: 100 });
  let page = first, count = 0;
  do {
    count += page.reports.length;
    page = page.next ? await f.store.listReports({ missionId: f.ref.missionId, limit: 100, after: page.next }) : null;
  } while (page);
  assert.equal(count, 4201);
  const retry = await f.store.acknowledgeReport({ reportId: f.template.reportId, receiptId: f.template.expectedReceiptId });
  assert.equal(retry.state, 'delivered');
  const accepted = await f.store.accept(command('new-agent'));
  assert.equal(accepted.created, true);
  const next = { missionId: accepted.mission.missionId, generation: accepted.mission.generation };
  await f.store.prepareCloudRun({ ...next, startedAt: 2000 });
  await f.store.bindCloudRun({ ...next, runId: next.missionId, cloudGeneration: 1 });
  await f.store.prepareTurn({ ...next, turnId: randomUUID() });
  assert.equal((await f.store.getMission({ missionId: f.ref.missionId, target })).reportDelivery.delivered, 4201);
});

test('undelivered reports still enforce the per-agent limit', async t => {
  const f = await fixture(t, 'pending', 128);
  await assert.rejects(f.store.prepareTurn({ ...f.ref, turnId: randomUUID() }), { code: 'report_capacity' });
  assert.equal((await f.store.listReports({ missionId: f.ref.missionId })).reports.every(report => report.payload), true);
});

test('undelivered reports across agents still enforce the global limit', async t => {
  const f = await fixture(t, 'pending', 4096, true);
  await assert.rejects(f.store.accept(command('new-agent')), { code: 'report_capacity' });
  assert.equal((await f.store.listDueReports({ limit: 100 })).length, 100);
});
