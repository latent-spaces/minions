// Explicitly opt-in paid smoke check. Never imported by the test suite.
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, realpath, writeFile, readFile } from 'node:fs/promises';
import { tmpdir, release } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { z } from 'zod/v4';
import { openRuntimeStore } from '../src/service/store.mjs';
import { createRuntimeControllers } from '../src/service/controllers.mjs';
import { createNativeAdapterFactory, checkoutGitEnvironment } from '../src/service/native-bindings.mjs';
import { startRuntimeService } from '../src/service/mcp-service.mjs';
import { createRuntimeApplication } from '../src/service/application.mjs';
import { createSteering } from '../src/service/steering.mjs';
import { createProvider } from '../runtime/providers.mjs';
import { nativeSmokeOptions } from './native-smoke-options.mjs';
import { nativeSmokeCoordination } from './native-smoke-coordination.mjs';
import { nativeSmokeSummary } from './native-smoke-report.mjs';

const options = nativeSmokeOptions(process.argv.slice(2));
const root = await realpath(await mkdtemp(join(tmpdir(), 'mlswarm-live-native-')));
const report = { startedAt: new Date().toISOString(), node: process.version, platform: process.platform, architecture: process.arch, osRelease: release(), root, realModels: true, syntheticCoordination: true, deadlineMs: options.timeoutSeconds * 1000, providers: {} };
const emit = value => console.log(JSON.stringify(value));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const bridges = [], clients = [], missions = [];
let controllers, store, service, cleanupPromise;
const deadlineAt = Date.now() + report.deadlineMs;
const principal = { site: 'https://synthetic.example', ownerId: 'smoke-owner' };
async function bridge(provider) {
  const token = randomBytes(32).toString('hex');
  const route = `/worker/${randomBytes(16).toString('hex')}/mcp`;
  const calls = [];
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'mlswarm-smoke-project', version: '1.0.0' });
    const tools = { get_project: { name: `Synthetic smoke ${provider}`, rules: 'Only this disposable local smoke task is authorized.', started: true, paused: false }, read_agent_inbox: [], list_human_requests: [] };
    for (const [name, value] of Object.entries(tools)) server.registerTool(name, { inputSchema: z.object({}).passthrough(), annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }, async () => {
      calls.push(name); return { content: [{ type: 'text', text: JSON.stringify(value) }] };
    });
    return server;
  });
  const nodeHandler = toNodeHandler(handler);
  let authority;
  const server = http.createServer(async (req, res) => {
    if (req.headers.host !== authority || req.headers.authorization !== `Bearer ${token}` || req.url !== route || (req.headers.origin && req.headers.origin !== `http://${authority}`)) { res.writeHead(403); res.end(); return; }
    try { await nodeHandler(req, res); } catch { res.end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  authority = `127.0.0.1:${server.address().port}`;
  let closed;
  const close = () => closed ??= (async () => { const stopped = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await handler.close(); await stopped; })();
  const entry = { url: `http://${authority}${route}`, token, calls, revoke: close, close };
  bridges.push(entry); return entry;
}
async function cleanup() {
  return cleanupPromise ??= (async () => {
    const errors = [];
    const close = async fn => { try { await fn(); } catch (error) { errors.push(error.message); } };
    // Controllers need the live store to persist native cleanup first.
    await close(() => controllers?.close());
    for (const client of clients) await close(() => client.close());
    await close(() => service?.close());
    await close(() => store?.close());
    for (const entry of bridges) await close(() => entry.close());
    if (errors.length) { report.cleanupErrors = errors; throw new Error('Smoke resource cleanup failed; inspect the private report.'); }
  })();
}
process.once('SIGINT', () => { void cleanup().finally(() => process.exit(130)); });
process.once('SIGTERM', () => { void cleanup().finally(() => process.exit(143)); });
const watchdog = setTimeout(() => { void cleanup().finally(() => process.exit(124)); }, report.deadlineMs + 30000);
emit({ phase: 'preparing', root, deadlineAt });
try {
  report.phase = 'source';
  report.sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fileURLToPath(new URL('../../../', import.meta.url)), env: checkoutGitEnvironment(), encoding: 'utf8', windowsHide: true }).trim();
  const bindings = [];
  for (const provider of ['claude', 'codex']) {
    report.phase = `preflight-${provider}`;
    const folder = join(root, provider, 'checkout'), stateDir = join(root, provider, 'state');
    await mkdir(folder, { recursive: true, mode: 0o700 }); await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const gitEnv = checkoutGitEnvironment();
    execFileSync('git', ['init', '-q', folder], { env: gitEnv, windowsHide: true });
    execFileSync('git', ['-C', folder, 'remote', 'add', 'origin', `https://github.com/synthetic/smoke-${provider}.git`], { env: gitEnv, windowsHide: true });
    const instructions = 'This is a short, isolated, operator-approved live smoke test. Only use the supplied read-only pilot MCP tools and write the specifically requested text files in this checkout. Do not access other folders, GitHub, other network services, run shell commands, spawn processes/agents, install anything or change settings. Native model API use is authorized. Keep responses brief. End every turn with WORK_NEXT: waiting.';
    await writeFile(join(stateDir, 'instructions.md'), instructions, { mode: 0o600 });
    const projectBridge = await bridge(provider);
    const preflight = await createProvider(provider, { ...options.executables, model: options.models[provider], repoDir: folder, permissionMode: 'acceptEdits', passEnv: '', turnBudgetUsd: 0 }, { envSource: process.env }).preflight();
    report.providers[provider] = { selectedModel: options.models[provider], clientVersion: preflight.label };
    bindings.push({ target: { site: 'https://synthetic.example', ownerId: 'smoke-owner', projectId: `smoke-${provider}`, agentId: provider }, repository: `synthetic/smoke-${provider}`, folder, stateDir, createBridge: async () => projectBridge,
      readProjectState: async () => ({ project: { started: true, paused: false, closed: false }, pending: 0, acknowledged: 0 }),
      prepareParticipation: async () => ({ project: { name: `Synthetic smoke ${provider}`, rules: instructions, nativeTasksEnabled: false, mergeApproval: 'humans' } }),
    });
  }
  store = await openRuntimeStore({ directory: join(root, 'ledger') });
  report.phase = 'starting';
  const coordination = nativeSmokeCoordination(principal);
  controllers = createRuntimeControllers({ store, cloudFactory: coordination.cloudFactory, observeIntervalMs: 100, adapterFactory: createNativeAdapterFactory({ bindings, registryRoot: join(root, 'ownership'), executables: options.executables, envSource: process.env }) });
  const steering = createSteering({ store, principal, accountClient: coordination.accountClient });
  const application = createRuntimeApplication({ controllers, principal, steering });
  service = await startRuntimeService({ controllers, principal, application });
  const call = async (client, name, args) => {
    const result = await client.callTool({ name, arguments: args });
    const value = JSON.parse(result.content.find(item => item.type === 'text').text);
    if (result.isError) throw new Error(JSON.stringify(value)); return value;
  };
  for (const binding of bindings) {
    const provider = binding.target.agentId;
    const client = new Client({ name: `smoke-operator-${provider}`, version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(service.url), { requestInit: { headers: { Authorization: `Bearer ${service.token}` } } }));
    clients.push(client);
    const nonce = randomUUID();
    const command = { operationId: randomUUID(), kind: 'start', target: { projectId: binding.target.projectId, agentId: binding.target.agentId }, missionId: randomUUID(), payload: { execution: { provider, model: options.models[provider] }, deadlineAt,
      scope: `Call the supplied get_project MCP tool once. Using your file-editing tool, write exactly ${nonce} into INITIAL.txt in this checkout. Do nothing else. Finish with a brief success statement and WORK_NEXT: waiting. If later steering supplies a second file, follow it in that later turn.` } };
    const accepted = await call(client, 'control_agent', command);
    missions.push({ binding, client, command, nonce, mission: accepted.mission });
    report.providers[provider] = { ...report.providers[provider], missionId: accepted.mission.missionId };
    emit({ phase: 'accepted', provider });
  }
  report.phase = 'running';
  while (Date.now() < deadlineAt) {
    let done = 0;
    for (const entry of missions) {
      const { binding, client, mission } = entry;
      const state = await call(client, 'get_agent_run', { target: { projectId: mission.target.projectId, agentId: mission.target.agentId }, missionId: mission.missionId });
      entry.latest = state;
      const signature = `${state.state}:${state.steering.map(item => item.state).join(',')}:${state.outcomes.length}`;
      if (signature !== entry.signature) { entry.signature = signature; emit({ phase: 'progress', provider: binding.target.agentId, state: state.state, steering: state.steering.map(item => item.state), outcomes: state.outcomes.length }); }
      // currentTurnId proves a reserved first turn, not native submission/ACK.
      if (!entry.steer && state.currentTurnId && state.outcomes.length === 0) {
        entry.steer = { operationId: randomUUID(), kind: 'steer', target: { projectId: mission.target.projectId, agentId: mission.target.agentId }, missionId: mission.missionId, generation: mission.generation, payload: { message: `Using the file-editing tool, write exactly ${entry.nonce} into STEERING.txt in this checkout. Do nothing else. End with WORK_NEXT: waiting.` } };
        await call(client, 'control_agent', entry.steer);
        // Shared steering is recorded before the controller imports it. Wait for
        // that receipt instead of mistaking a transport round trip for delivery.
        const queueUntil = Math.min(deadlineAt, Date.now() + 5000);
        while (Date.now() < queueUntil) {
          const queued = await call(client, 'get_agent_run', { target: { projectId: mission.target.projectId, agentId: mission.target.agentId }, missionId: mission.missionId });
          const receipt = queued.steering.find(item => item.operationId === entry.steer.operationId);
          if (receipt || queued.outcomes.length > 0) { entry.queuedDuringTurn = receipt?.state === 'queued' && queued.outcomes.length === 0; break; }
          await sleep(50);
        }
      }
      if (state.outcomes.length >= 2 || ['failed', 'stopped', 'recovery_required', 'blocked'].includes(state.state)) done++;
    }
    if (done === missions.length) break;
    await sleep(300);
  }
  for (const entry of missions) {
    const provider = entry.binding.target.agentId;
    const state = await call(entry.client, 'get_agent_run', { target: { projectId: entry.mission.target.projectId, agentId: entry.mission.target.agentId }, missionId: entry.mission.missionId });
    report.providers[provider] = { ...report.providers[provider], state: state.state, reason: state.reason, queuedDuringTurn: entry.queuedDuringTurn === true, bridgeCalls: bridges[missions.indexOf(entry)].calls,
      steering: state.steering.map(item => item.state), outcomes: state.outcomes.map(item => ({ text: item.text, outcome: item.outcome })) };
    await call(entry.client, 'control_agent', { operationId: randomUUID(), kind: 'stop', target: { projectId: entry.mission.target.projectId, agentId: entry.mission.target.agentId }, missionId: entry.mission.missionId, generation: entry.mission.generation, payload: {} });
  }
  await controllers.close();
  for (const entry of missions) {
    const state = await store.getMission({ target: entry.mission.target, missionId: entry.mission.missionId });
    report.providers[entry.binding.target.agentId].stopped = { state: state.state, guardPid: state.guardPid, currentTurnId: state.currentTurnId };
  }
  await cleanup();
  report.phase = 'verifying';
  const reopened = await openRuntimeStore({ directory: join(root, 'ledger') });
  try {
    for (const entry of missions) {
      const provider = entry.binding.target.agentId;
      const persisted = await reopened.getMission({ target: entry.mission.target, missionId: entry.mission.missionId });
      const result = report.providers[provider];
      result.reopenedOutcomeCount = persisted.outcomes.length;
      result.initialFile = (await readFile(join(entry.binding.folder, 'INITIAL.txt'), 'utf8').catch(() => '')).trim() === entry.nonce;
      result.steeringFile = (await readFile(join(entry.binding.folder, 'STEERING.txt'), 'utf8').catch(() => '')).trim() === entry.nonce;
      assert.equal(result.queuedDuringTurn, true, `${provider}: steering queued during first turn`);
      assert.ok(result.bridgeCalls.includes('get_project'), `${provider}: actual local MCP project read`);
      assert.equal(result.initialFile, true, `${provider}: initial result`);
      assert.equal(result.steeringFile, true, `${provider}: steering result`);
      assert.equal(result.steering[0], 'applied', `${provider}: native acknowledged steering`);
      assert.equal(result.reopenedOutcomeCount, 2, `${provider}: persisted two turns`);
      assert.ok(result.outcomes.every(item => item.outcome.failed === false && item.outcome.cleanupConfirmed === true), `${provider}: successful cleanup`);
      assert.ok(result.outcomes.every(item => item.outcome.delivery === 'acknowledged' && (item.outcome.usage?.tokens?.input ?? 0) + (item.outcome.usage?.tokens?.output ?? 0) > 0), `${provider}: acknowledged real model usage`);
      assert.equal(result.stopped.state, 'stopped');
      assert.equal(result.stopped.guardPid, null);
    }
  } finally { await reopened.close(); }
  report.passed = true;
  report.phase = 'finished';
} catch (error) { report.passed = false; report.error = error.message; process.exitCode = 1; }
finally {
  try { await cleanup(); } catch (error) { report.passed = false; report.error ??= error.message; process.exitCode = 1; }
  clearTimeout(watchdog);
  report.finishedAt = new Date().toISOString();
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  const summary = nativeSmokeSummary(report);
  await writeFile(join(root, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
  emit({ phase: 'finished', passed: report.passed, summary: join(root, 'summary.json'), privateReport: join(root, 'report.json') });
}
