import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { openRuntimeStore } from '../src/service/store.mjs';
import { createRuntimeApplication } from '../src/service/application.mjs';
import { startRuntimeService } from '../src/service/mcp-service.mjs';
import { createRunEvidence } from '../src/service/run-evidence.mjs';
import { createRunJournal } from '../src/run-journal.mjs';

const owner = { kind: 'owner', site: 'https://synthetic.invalid', ownerId: 'synthetic-owner' };
const principal = { site: owner.site, ownerId: owner.ownerId };
const publicTarget = target => ({ projectId: target.projectId, agentId: target.agentId });
const tools = ['get_agent_run_log', 'get_agent_run_diagnostics'];
const value = response => JSON.parse(response.content.find(item => item.type === 'text').text);

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'minions-evidence-audit-')));
  const registryRoot = join(root, 'ownership');
  await mkdir(registryRoot, { mode: 0o700 });
  const store = await openRuntimeStore({ directory: join(root, 'ledger') });
  t.after(async () => { await store.close(); await rm(root, { force: true, recursive: true }); });
  const missions = [], bindings = new Map(), directories = [], secret = 'synthetic-bridge-secret';
  for (const [index, provider] of ['claude', 'codex'].entries()) {
    const target = { site: owner.site, ownerId: owner.ownerId, projectId: `project-${index}`, agentId: `agent-${index}` };
    const { mission } = await store.accept({ version: 2, operationId: randomUUID(), kind: 'start', missionId: randomUUID(), target,
      payload: { scope: 'Synthetic historical inspection only; never execute a model.', deadlineAt: Date.now() + 300000, execution: { provider, model: null } } });
    missions.push(mission);
    const stateDir = join(root, `private-${index}`), folder = join(root, `checkout-${index}`);
    const directory = join(stateDir, `mission-${mission.missionId}-${mission.generation}`);
    await mkdir(directory, { recursive: true, mode: 0o700 }); await mkdir(folder, { mode: 0o700 });
    bindings.set(target.projectId, { stateDir, folder }); directories.push(directory);
    const journal = createRunJournal({ directory, identity: { target, missionId: mission.missionId,
      generation: mission.generation, provider, model: null }, redact: [secret] });
    const attemptId = randomUUID(), turnId = randomUUID();
    journal.append({ kind: 'attempt_started', attemptId, turnId });
    journal.append({ kind: 'assistant_text', attemptId, turnId, text: `${provider} synthetic saved output ${secret}` });
    journal.append({ kind: 'attempt_finished', attemptId, turnId, failed: false, interrupted: false, cleanupConfirmed: true });
    assert.equal(journal.status().availability, 'available');
  }
  let bindingReads = 0, journalReads = 0;
  const controllers = { getMission: input => store.getMission(input), listReports: input => store.listReports(input) };
  const evidence = createRunEvidence({ controllers, principal, registryRoot,
    resolveBinding: target => { bindingReads++; return bindings.get(target.projectId); },
    resolveJournalDirectory: mission => {
      journalReads++;
      const index = missions.findIndex(item => item.missionId === mission.missionId);
      assert.ok(index >= 0, 'only an authoritative recorded mission can resolve private evidence');
      return directories[index];
    } });
  const app = createRuntimeApplication({ controllers, principal, evidence });
  return { app, controllers, missions, directories, secret,
    get bindingReads() { return bindingReads; }, get journalReads() { return journalReads; } };
}

test('private evidence tools fence owner, worker, foreign target and path selectors before local reads', async t => {
  const f = await fixture(t), mission = f.missions[0];
  const query = { missionId: mission.missionId, target: publicTarget(mission.target) };
  for (const name of tools) {
    const metadata = f.app.listTools(owner).find(tool => tool.name === name);
    assert.equal(metadata.annotations.readOnlyHint, true);
    assert.equal(metadata.annotations.destructiveHint, false);
    const initialReads = f.bindingReads;
    const initialJournalReads = f.journalReads;
    const worker = { kind: 'worker', target: mission.target, missionId: mission.missionId, generation: mission.generation };
    assert.ok(!f.app.listTools(worker).some(tool => tool.name === name));
    assert.equal(value(await f.app.callTool(worker, name, query)).error.code, 'unknown_tool');
    assert.equal(value(await f.app.callTool({ ...owner, ownerId: 'foreign-owner' }, name, query)).error.code, 'forbidden');
    assert.equal(value(await f.app.callTool(owner, name, { ...query, target: { ...publicTarget(mission.target), ownerId: 'foreign-owner' } })).error.code, 'bad_input');
    assert.equal(value(await f.app.callTool(owner, name, { ...query, target: publicTarget(f.missions[1].target) })).error.code, 'forbidden');
    for (const additional of [{ path: '/etc/passwd' }, { directory: f.directories[1] }, { generation: 2 }, { target: { ...mission.target, path: '/etc/passwd' } }]) {
      const result = await f.app.callTool(owner, name, { ...query, ...additional });
      assert.equal(value(result).error.code, 'bad_input');
    }
    assert.equal(f.bindingReads, initialReads, 'denied requests cannot resolve private storage');
    assert.equal(f.journalReads, initialJournalReads, 'denied requests cannot resolve retained journal paths');
  }
});

test('two authenticated MCP clients inspect separated historical provider journals without execution or consumption', async t => {
  const f = await fixture(t), clients = [];
  const service = await startRuntimeService({ controllers: f.controllers, principal, application: f.app });
  t.after(async () => { await Promise.all(clients.map(client => client.close())); await service.close(); });
  for (const name of ['synthetic-Claude-inspector', 'synthetic-Codex-inspector']) {
    const client = new Client({ name, version: '0.0.0-test' });
    await client.connect(new StreamableHTTPClientTransport(new URL(service.url), { requestInit: { headers: { Authorization: `Bearer ${service.token}` } } }));
    clients.push(client);
  }
  for (const mission of f.missions) {
    const query = { missionId: mission.missionId, target: publicTarget(mission.target), limit: 1 };
    const first = value(await clients[0].callTool({ name: tools[0], arguments: query }));
    assert.equal(first.availability, 'available'); assert.equal(first.hasMore, true); assert.equal(first.records.length, 1);
    assert.deepEqual(value(await clients[1].callTool({ name: tools[0], arguments: query })), first);
    const next = value(await clients[1].callTool({ name: tools[0], arguments: { ...query, after: first.nextAfter } }));
    assert.match(next.records[0].text, new RegExp(`${mission.execution.provider} synthetic saved output`));
    assert.ok(!JSON.stringify(next).includes(f.secret));
    assert.ok(JSON.stringify(next).includes('[REDACTED]'));
    assert.ok(!JSON.stringify(next).includes(f.missions.find(item => item !== mission).missionId));
  }
});

test('corrupt journal records cannot smuggle tool inputs or another mission identity through owner APIs', async t => {
  const f = await fixture(t), mission = f.missions[0], query = { missionId: mission.missionId, target: publicTarget(mission.target) };
  const file = join(f.directories[0], 'run-evidence.jsonl');
  const lines = (await readFile(file, 'utf8')).trimEnd().split('\n');
  const record = JSON.parse(lines[2]); record.arguments = { secret: 'synthetic-private-tool-input' };
  lines[2] = JSON.stringify(record);
  await writeFile(file, `${lines.join('\n')}\n`);
  const saved = await readFile(file, 'utf8');
  const corrupt = value(await f.app.callTool(owner, tools[0], query));
  assert.equal(corrupt.availability, 'corrupt');
  assert.ok(!JSON.stringify(corrupt).includes('synthetic-private-tool-input'));
  assert.equal(await readFile(file, 'utf8'), saved, 'reading a corrupt record never repairs or truncates it');
  await writeFile(file, await readFile(join(f.directories[1], 'run-evidence.jsonl')));
  const mismatched = value(await f.app.callTool(owner, tools[0], query));
  assert.equal(mismatched.availability, 'corrupt');
  assert.deepEqual(mismatched.records, []);
  assert.ok(!JSON.stringify(mismatched).includes('codex synthetic saved output'));
});
