import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createOwnerParticipationControls } from '../src/service/owner-participation-controls.mjs';
import { createConfirmedSnapshots } from '../src/service/owner-snapshot-refresh.mjs';

// Model-free: a fake clock and fake ports count the owner-budget syncs one computer sends.
const principal = { site: 'http://127.0.0.1:8787', ownerId: 'owner' };
const targets = Array.from({ length: 40 }, (_, i) => ({ ...principal, projectId: `project-${i}`, agentId: `agent-${i}` }));
function fixture(t) {
  let clock = 1_000_000, failing = false;
  const chat = new Map(targets.map(target => [target.agentId, { target, participationId: randomUUID(), generation: 1, state: 'active',
    scope: 'Synthetic scope', approvedAt: 1, deadlineAt: 9e12, cloudRun: null }]));
  const missions = new Map(targets.slice(0, 3).map(target => [target.agentId, { target, missionId: randomUUID(), generation: 1, deadlineAt: 9e12,
    state: 'running', pauseOperationId: null, cloudRun: null, updatedAt: 5 }]));
  const sent = { chat: [], background: [] };
  const pick = (rows, query) => query.targets.flatMap(target => rows.has(target.agentId) ? [structuredClone(rows.get(target.agentId))] : []);
  const pump = createOwnerParticipationControls({ principal, targets, intervalMs: 3_600_000, timeoutMs: 500, now: () => clock,
    store: { latestParticipationsForTargets: async query => pick(chat, query), latestBackgroundsForTargets: async query => pick(missions, query) },
    participation: { command: () => assert.fail('No work authorized') },
    controllers: { accept: () => assert.fail('No work authorized'), getMission: () => assert.fail('No work authorized') },
    ownerClient: {
      syncParticipations: async body => { if (failing) throw new Error('synthetic 429'); sent.chat.push(body.participations.map(row => row.target.agentId)); return { ok: true }; },
      syncBackgrounds: async body => { if (failing) throw new Error('synthetic 429'); sent.background.push(body.backgrounds.map(row => row.target.agentId)); return { ok: true }; },
      listParticipationControls: async () => ({ commands: [], serverTime: clock }),
      listBackgroundControls: async () => ({ commands: [], serverTime: clock }),
      acceptParticipationControl: () => assert.fail('No controls'), acknowledgeParticipationControl: () => assert.fail('No controls'),
      acknowledgeBackgroundControl: () => assert.fail('No controls'),
    } });
  t.after(() => pump.close());
  const reset = () => { sent.chat.length = 0; sent.background.length = 0; };
  return { pump, chat, missions, sent, reset, tick: ms => { clock += ms; }, set failing(v) { failing = v; } };
}

test('unchanged confirmed pages resend on every third 15 s tick, even with early timer jitter', async t => {
  const f = fixture(t);
  await f.pump.poll();
  assert.equal(f.sent.chat.length, 2); // 40 bindings: pages of 32 and 8
  assert.equal(f.sent.background.length, 1);
  f.reset();
  // Ticks arrive slightly early; the stamp still lands on the third tick, not the fourth.
  for (const ms of [14_990, 14_990]) { f.tick(ms); await f.pump.poll(); }
  assert.deepEqual(f.sent, { chat: [], background: [] });
  f.tick(14_990); await f.pump.poll(); // about 45 s after the confirmed send
  assert.equal(f.sent.chat.length, 2); assert.equal(f.sent.background.length, 1);
  // Twelve 15 s ticks over three minutes: 4 syncs per page instead of 12.
  f.reset();
  for (let i = 0; i < 12; i++) { f.tick(14_990); await f.pump.poll(); }
  assert.equal(f.sent.chat.length, 2 * 4); assert.equal(f.sent.background.length, 4);
});

test('a changed row sends its page on the next tick; unchanged pages stay quiet', async t => {
  const f = fixture(t);
  await f.pump.poll(); f.reset();
  f.tick(15_000);
  f.chat.get('agent-35').deadlineAt += 300_000; // second page only
  f.missions.get('agent-1').state = 'paused';
  await f.pump.poll();
  assert.equal(f.sent.chat.length, 1); assert.ok(f.sent.chat[0].includes('agent-35'));
  assert.equal(f.sent.background.length, 1);
  f.tick(15_000); await f.pump.poll();
  assert.equal(f.sent.chat.length, 1); assert.equal(f.sent.background.length, 1);
});

test('a refused or failed sync is never treated as confirmed and retries on the next tick', async t => {
  const f = fixture(t);
  f.failing = true; await f.pump.poll();
  assert.deepEqual(f.sent, { chat: [], background: [] });
  f.failing = false; f.tick(15_000); await f.pump.poll();
  assert.equal(f.sent.chat.length, 2); assert.equal(f.sent.background.length, 1);
  // A failure after confirmation does not extend freshness: the next stale tick sends.
  f.reset(); f.tick(40_000); f.failing = true; await f.pump.poll();
  f.failing = false; f.tick(15_000); await f.pump.poll();
  assert.equal(f.sent.chat.length, 2); assert.equal(f.sent.background.length, 1);
});

test('confirmed rows for removed bindings are dropped and the refresh cannot exceed 60 s', () => {
  let at = 0;
  const confirmed = createConfirmedSnapshots({ now: () => at }); // default 40 s
  const row = { target: targets[0], state: 'active' };
  assert.equal(confirmed.fresh([]), false);
  confirmed.confirm([row], 0);
  assert.equal(confirmed.fresh([row]), true);
  assert.equal(confirmed.fresh([{ ...row, state: 'released' }]), false);
  confirmed.retain([targets[1]]);
  assert.equal(confirmed.fresh([row]), false);
  confirmed.confirm([row], 0); at = 39_999;
  assert.equal(confirmed.fresh([row]), true);
  at = 40_000;
  assert.equal(confirmed.fresh([row]), false);
  for (const refreshMs of [0, 60_001, 1.5]) assert.throws(() => createConfirmedSnapshots({ refreshMs }), TypeError);
});
