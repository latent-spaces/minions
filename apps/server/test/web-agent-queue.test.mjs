import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { hashToken } from '../src/auth.js';
import { collection, inProject } from '../src/firestore.js';
import { connectOwnAgent } from '../src/owner/agents.js';
import { acceptAgentStart, createWebAgentStart, publishRuntimeReadiness, readAgentStarts, receiptAgentStart } from '../src/owner/web-agent-starts.js';
import { listMyWorkers } from '../src/projects/worker-sessions.js';
import { resetEmulator, seed, seedRuntime, TEST_PROJECT } from './helpers.js';
import { createWebAgentStarts } from '../../../packages/agent-cli/src/service/web-agent-starts.mjs';

// The website queues a new agent for an offline computer; the computer's service, started later, takes it on its
// first check, so it leaves the queue and shows as the person's agent. Real server and service code; no model runs.
test('an agent queued for an offline computer is picked up on the computer’s first check and leaves the queue', async () => {
  await resetEmulator();
  const now = () => Date.now(), site = 'https://mlswarm.test';
  const owner = (await seed({ profiles: [{ name: 'Owner', email: 'queue-owner@example.test' }] })).personIds[0], computer = randomUUID();
  await collection('computerConnections').doc(computer).set({ profileId: owner, revokedAt: null, approvedAt: now(), connectionExpiresAt: now() + 86400_000 });
  const workers = () => inProject(TEST_PROJECT, () => listMyWorkers(owner, now));
  await seedRuntime(TEST_PROJECT, {});

  const id = randomUUID();
  await createWebAgentStart(owner, { id, connectionId: computer, projectId: TEST_PROJECT, name: 'queued-fox', execution: { provider: 'codex', model: null }, approved: true }, now);
  expect(await workers()).toMatchObject({ agents: [], queued: [{ id, name: 'queued-fox', waitingFor: 'computer' }] });

  const home = await mkdtemp(join(tmpdir(), 'mlswarm-queue-'));
  const service = createWebAgentStarts({ home, principal: { site, ownerId: owner }, intervalMs: 600_000, platform: 'darwin',
    ownerClient: {
      publishRuntimeReadiness: (value) => publishRuntimeReadiness(owner, computer, value, now),
      listAgentStarts: () => readAgentStarts(owner, computer, {}, now),
      listRepositoryAccess: async () => ({ owned: [], joined: [] }),
      acceptAgentStart: (startId, value) => acceptAgentStart(owner, computer, startId, value, now),
      acknowledgeAgentStart: async (startId, value) => { await receiptAgentStart(owner, computer, startId, value, now); return { ok: true }; },
    },
    capabilities: async () => [{ id: 'codex', available: true, reason: 'ready' }],
    githubSignIn: async () => 'ready', syncAccess: async () => {},
    async addAgent(args, _client, options) {
      const added = await inProject(TEST_PROJECT, () => connectOwnAgent(owner, { name: args.agent_name, candidateTokenHash: hashToken(randomUUID()), clientName: 'test', folder: home, webStartId: options.webStartId }, now, computer));
      return { record: { webStartId: options.webStartId, ownerProfileId: owner, agentName: args.agent_name, agentId: added.agentId, service: `${site}/p/${TEST_PROJECT}` } };
    },
    prepareCheckout: async () => {},
    controllers: { accept: async () => {}, getMission: async () => ({ currentTurnStage: 'applied', outcomes: [] }) },
  });
  try {
    const deadline = Date.now() + 10_000;
    let mine = await workers();
    while ((mine.queued.length || mine.agents[0]?.run?.state !== 'working') && Date.now() < deadline) { await new Promise(r => setTimeout(r, 100)); mine = await workers(); }
    expect(mine.queued).toEqual([]);
    expect(mine.agents).toMatchObject([{ agentName: 'queued-fox', run: { id, state: 'working' } }]);
  } finally { await service.close(); await rm(home, { recursive: true, force: true }); }
});
