import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createOwnerParticipationControls } from '../src/service/owner-participation-controls.mjs';

const principal = { site: 'http://127.0.0.1:8787', ownerId: 'owner' };
const targets = ['park','garden'].map(projectId => ({ ...principal, projectId, agentId: `agent-${projectId}` }));
const record = (target = targets[0], extra = {}) => ({ target, participationId: randomUUID(), generation: 1, state: 'active', scope: 'Synthetic bounded scope', approvedAt: Date.now(), deadlineAt: Date.now()+300000, cloudRun: null, ...extra });
const release = p => ({ version: 1, operationId: randomUUID(), kind: 'release', target: p.target, participationId: p.participationId, generation: p.generation, payload: {} });
const extension = p => ({ ...release(p), kind: 'extend', payload: { approved: true, approvedAt: Date.now(), expectedDeadlineAt: p.deadlineAt, deadlineAt: p.deadlineAt+300000 } });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let i = 0; i < 200; i++) { if (check()) return; await sleep(5); } assert.fail('Synthetic owner delivery did not settle.'); }
function fixture(t, { rows = [], command } = {}) {
  const snapshots = [], received = [], acks = [], inbox = [], saved = new Map();
  let unavailable = false;
  const ownerClient = {
    async syncParticipations(value, options) { assert.equal(options.expectedProfileId, principal.ownerId); snapshots.push(structuredClone(value)); if (unavailable) throw new Error('private token must not leak'); return { ok: true }; },
    async listParticipationControls(options) { assert.equal(options.expectedProfileId, principal.ownerId); return { commands: inbox.filter(item => !saved.has(item.id)), serverTime: Date.now() }; },
    async acceptParticipationControl() { return { state: 'accepted' }; },
    async acknowledgeParticipationControl(id, receipt) { acks.push({ id, receipt: structuredClone(receipt) }); saved.set(id, receipt); return { ok: true }; },
  };
  const store = { async latestParticipationsForTargets(query) {
    assert.ok(query.targets.length <= targets.length);
    assert.ok(query.targets.every(value => targets.some(target => JSON.stringify(target) === JSON.stringify(value))));
    return rows.filter(row => query.targets.some(target => target.projectId === row.target.projectId && target.agentId === row.target.agentId));
  } };
  const participation = { async command(value) {
    received.push(value);
    return command(value, rows);
  } };
  const pump = createOwnerParticipationControls({ principal, targets, store, participation, ownerClient, intervalMs: 20, timeoutMs: 500 });
  t.after(() => pump.close());
  return { pump, snapshots, received, acks, inbox, saved, set unavailable(v) { unavailable = v; } };
}

test('idle owner delivery publishes bounded whitelisted snapshots and never exposes refs or credentials', async t => {
  const p = record(targets[0], { participationRef: randomUUID(), folder: '/private/synthetic', token: 'synthetic-secret' });
  const f = fixture(t, { rows: [p] });
  await until(() => f.snapshots.length > 0);
  const snapshot = f.snapshots[0].participations[0];
  assert.deepEqual(Object.keys(snapshot), ['target','participationId','generation','state','scope','approvedAt','deadlineAt','cloudRun']);
  assert.ok(!JSON.stringify(snapshot).includes('synthetic-secret'));
  assert.ok(!JSON.stringify(snapshot).includes(p.participationRef));
  const empty = fixture(t); await empty.pump.poll(); assert.deepEqual(empty.snapshots, []);
});

test('unknown targets, owners and claim commands are rejected before dispatch with safe fixed errors', async t => {
  const p = record(), f = fixture(t, { rows: [p] });
  const foreign = release({ ...p, target: { ...p.target, ownerId: 'other' } });
  const unknown = release({ ...p, target: { ...p.target, agentId: 'unknown' } });
  const claim = { version: 1, operationId: randomUUID(), kind: 'claim', target: p.target, participationId: randomUUID(), payload: { approved: true, approvedAt: Date.now(), deadlineAt: Date.now()+300000, scope: 'not install authority' } };
  f.inbox.push(...[foreign,unknown,claim].map(command => ({ id: command.operationId, command })));
  await until(() => f.saved.size === 3); assert.equal(f.received.length, 0);
  assert.ok(f.acks.every(ack => ack.receipt.state === 'failed' && !ack.receipt.message.includes('token')));
});

test('permanent cloud refusal acknowledges failed despite a refused snapshot, without retrying or leaking errors', async t => {
  for (const code of ['run_superseded','runtime_conflict','bad_input','unauthorized','not_found','run_active']) {
    const p = record(), f = fixture(t, { rows: [p], command: async () => { throw Object.assign(new Error('synthetic-private-token'), { code }); } });
    f.unavailable = true;
    const command = extension(p); f.inbox.push({ id: command.operationId, command });
    await until(() => f.saved.has(command.operationId));
    assert.equal(f.saved.get(command.operationId).state, 'failed');
    assert.ok(!JSON.stringify(f.acks).includes('synthetic-private-token'));
    assert.equal(f.received.length, 1); await f.pump.close();
  }
});

test('137 idle saved bindings poll control mailboxes without publishing empty snapshot pages', async t => {
  const many = Array.from({ length: 137 }, (_, i) => ({ ...principal, projectId: `project-${i}`, agentId: `agent-${i}` }));
  let snapshots = 0, chatReads = 0, backgroundReads = 0;
  const pump = createOwnerParticipationControls({ principal, targets: many, intervalMs: 60000, timeoutMs: 500,
    store: { latestParticipationsForTargets: async () => [], latestBackgroundsForTargets: async () => [] },
    participation: { command: () => assert.fail('No work authorized') },
    controllers: { accept: () => assert.fail('No work authorized'), getMission: () => assert.fail('No work authorized') },
    ownerClient: {
      syncParticipations: async () => { snapshots++; return { ok: true }; },
      syncBackgrounds: async () => { snapshots++; return { ok: true }; },
      listParticipationControls: async () => { chatReads++; return { commands: [], serverTime: Date.now() }; },
      listBackgroundControls: async () => { backgroundReads++; return { commands: [], serverTime: Date.now() }; },
      acceptParticipationControl: () => assert.fail('No controls'),
      acknowledgeParticipationControl: () => assert.fail('No controls'), acknowledgeBackgroundControl: () => assert.fail('No controls'),
    },
  });
  t.after(() => pump.close()); await pump.poll();
  assert.equal(snapshots, 0); assert.equal(chatReads, 1); assert.equal(backgroundReads, 1);
});
