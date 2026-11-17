import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWebAgentStarts } from '../src/service/web-agent-starts.mjs';

const site = 'http://127.0.0.1:18787', projectId = 'a'.repeat(64), principal = { site, ownerId: 'owner' };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// A burst of website starts on one computer (owner report: 5 of ~11 failed as preparation_failed, nothing logged).
test('a burst of starts launches one at a time, shares one provider probe, and keeps the real failure reason', async t => {
  const root = await mkdtemp(join(tmpdir(), 'minions-web-starts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'service'); await mkdir(home, { mode: 0o700 });
  const incarnation = randomUUID(), names = ['ann', 'bob', 'cid', 'dee'];
  const requests = names.map(name => ({ id: randomUUID(), projectId, name, scope: 'Work toward the project goal.', execution: { provider: 'claude', model: null },
    incarnation, state: 'accepted', createdAt: Date.now(), pickupByAt: Date.now() + 600_000, launchByAt: Date.now() + 180_000, deadlineAt: Date.now() + 3_600_000, agentId: null }));
  let probes = 0, preparing = 0, mostAtOnce = 0, polled = false;
  const receipts = [], logs = [], accepted = [];
  const ownerClient = {
    async publishRuntimeReadiness() { return {}; },
    async listAgentStarts() { if (polled) return { requests: [], serverTime: Date.now() }; polled = true; return { requests, serverTime: Date.now() }; },
    async acceptAgentStart(id) { return { request: { ...requests.find(r => r.id === id), state: 'accepted' } }; },
    async acknowledgeAgentStart(id, receipt) { receipts.push({ id, ...receipt }); return { ok: true }; },
  };
  const starts = createWebAgentStarts({ home, principal, ownerClient, incarnation, intervalMs: 3_600_000, log: line => logs.push(line),
    controllers: { async accept(command) { accepted.push(command.target.agentId); }, async getMission() { return null; } },
    capabilities: async () => { probes++; await pause(30); return [{ id: 'claude', available: true, reason: 'ready' }]; },
    githubSignIn: async () => 'signed_out',
    addAgent: async ({ agent_name }, _client, options) => ({ record: { agentId: `agent-${agent_name}`, webStartId: options.webStartId, ownerProfileId: 'owner', agentName: agent_name, service: `${site}/p/${projectId}`, folder: join(root, agent_name) } }),
    prepareCheckout: async record => {
      mostAtOnce = Math.max(mostAtOnce, ++preparing); await pause(20); preparing--;
      if (record.agentName === 'cid') throw Object.assign(new Error('Command failed: git rev-parse (timed out) token ghp_secretsecret'), { code: 'ETIMEDOUT' });
    } });
  await starts.poll();
  for (const until = Date.now() + 5000; accepted.length + receipts.filter(r => r.state === 'failed').length < 4 && Date.now() < until;) await pause(10);
  await starts.close();
  assert.equal(mostAtOnce, 1, 'launches take turns');
  assert.equal(probes, 1, 'the launches reuse the poll\'s fresh probe');
  assert.deepEqual(accepted.sort(), ['agent-ann', 'agent-bob', 'agent-dee']);
  const failed = requests[2];
  assert.equal(receipts.find(r => r.id === failed.id && r.state === 'failed').code, 'preparation_failed');
  const intent = JSON.parse(await readFile(join(home, 'web-starts', `${failed.id}.json`), 'utf8'));
  assert.equal(intent.failure.step, 'preparing the checkout');
  assert.equal(intent.failure.code, 'ETIMEDOUT');
  assert.match(intent.failure.message, /timed out/);
  assert.doesNotMatch(JSON.stringify(intent) + logs.join('\n'), /ghp_secret/);
  assert.ok(logs.some(line => line.includes(failed.id) && line.includes('preparing the checkout') && line.includes('ETIMEDOUT')), logs.join('\n'));
});
