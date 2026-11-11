// Disposable process-crash target. Uses only synthetic credentials and loopback peers.
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openRuntimeStore } from '../../src/service/store.mjs';
import { createReportDelivery } from '../../src/service/report-delivery.mjs';

const [directory, mode, url] = process.argv.slice(2);
const target = { site: 'https://fixture.invalid', ownerId: 'synthetic-owner', projectId: 'crash-project', agentId: 'crash-agent' };
const store = await openRuntimeStore({ directory: join(directory, 'state') });
const command = { version: 2, operationId: randomUUID(), missionId: randomUUID(), kind: 'start', target,
  payload: { scope: 'Synthetic report durability only', deadlineAt: Date.now() + 60000, execution: { provider: 'codex', model: null } } };
const { mission } = await store.accept(command);
await store.prepareCloudRun({ ...mission, startedAt: 1000 });
await store.bindCloudRun({ ...mission, runId: mission.missionId, cloudGeneration: 1 });
const turnId = randomUUID();
await store.prepareTurn({ ...mission, turnId });
await store.recordTurn({ ...mission, turnId, startedAt: 1000, endedAt: 2500, text: 'Saved synthetic result',
  outcome: { delivery: 'acknowledged', failed: false, interrupted: false, retryable: false, cleanupConfirmed: true,
    usage: { provider: 'codex', model: 'synthetic-model', modelSource: 'provider-report', tokens: { input: 11, output: 7 } } } });
process.send({ stage: 'local_commit', missionId: mission.missionId, target });
const hold = () => new Promise(() => {});
if (mode === 'local_commit') await hold();
const acknowledgeReport = store.acknowledgeReport.bind(store);
store.acknowledgeReport = async input => {
  if (mode === 'before_ack') { process.send({ stage: 'before_ack' }); await hold(); }
  const result = await acknowledgeReport(input);
  if (mode === 'after_ack') { process.send({ stage: 'after_ack' }); await hold(); }
  return result;
};
const delivery = createReportDelivery({ store, intervalMs: 60000, send: async entry => {
  try {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(entry) });
    if (!response.ok) throw new Error('Synthetic response failure');
    return response.json();
  } catch (error) {
    if (mode === 'lost_response') { process.send({ stage: 'lost_response' }); await hold(); }
    throw error;
  }
} });
await delivery.drain();
process.send({ stage: 'drained' });
await hold();
