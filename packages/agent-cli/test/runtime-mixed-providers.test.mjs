import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { openRuntimeStore } from '../src/service/store.mjs';
import { createRuntimeControllers } from './fixtures/recorded-controllers.mjs';
import { createNativeAdapterFactory, checkoutGitEnvironment } from '../src/service/native-bindings.mjs';
import { makeMixedNativeFixtures, nativeEvents } from './fixtures/mixed-native-fixtures.mjs';
import { probeWebProviders } from '../src/service/web-agent-starts.mjs';

// The same offline protocol peers exercise the real adapters and native guards:
// executable scripts on POSIX and shell-free npm JS shims on Windows.
const nativeSkip = ['darwin', 'linux', 'win32'].includes(process.platform) ? false
  : 'Native worker supervision is unavailable on this platform.';
const nativeTimeout = milliseconds => process.platform === 'win32' ? 90000 : milliseconds;

const start = binding => ({ version: 2, operationId: randomUUID(), kind: 'start', target: binding.target, missionId: randomUUID(),
  payload: { scope: `Synthetic mission for ${binding.target.projectId}/${binding.target.agentId}`,
    execution: { provider: binding.target.agentId, model: `${binding.target.agentId}-${binding.target.projectId}-synthetic` } } });
const command = (mission, kind, payload = {}) => ({ version: 2, operationId: randomUUID(), kind, target: mission.target, missionId: mission.missionId, generation: mission.generation, payload });
const query = mission => ({ missionId: mission.missionId, target: mission.target });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, predicate, label) {
  const deadline = Date.now() + (process.platform === 'win32' ? 45000 : 12000);
  let value;
  while (Date.now() < deadline) { value = await read(); if (predicate(value)) return value; await sleep(15); }
  assert.fail(`Timed out: ${label}; last value: ${JSON.stringify(value)}`);
}
async function setup(t, selections, turns, configure = () => {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mlswarm-mixed-native-')));
  const fixtures = await makeMixedNativeFixtures(root, selections, turns);
  // Exercise the exact metadata environment before asynchronous controllers:
  // a native Git/config failure must be actionable, not a 45-second timeout.
  for (const binding of fixtures.bindings) {
    const origin = execFileSync('git', ['-C', binding.folder, 'remote', 'get-url', 'origin'], { env: checkoutGitEnvironment(), encoding: 'utf8', timeout: 5000 });
    assert.equal(origin.trim(), `https://github.com/${binding.repository}.git`);
  }
  await configure(fixtures);
  const directory = join(root, 'ledger');
  const store = await openRuntimeStore({ directory });
  let controllers;
  t.after(async () => { await controllers?.close(); await store.close(); await rm(root, { recursive: true, force: true }); });
  const adapterFactory = await createNativeAdapterFactory(fixtures);
  controllers = createRuntimeControllers({ store, adapterFactory,readSyntheticState:mission=>fixtures.bindings.find(b=>b.target.projectId===mission.target.projectId&&b.target.agentId===mission.target.agentId).readProjectState() });
  return { root, directory, ...fixtures, store, controllers, adapterFactory };
}
const inspect = (ctx, mission) => () => ctx.controllers.getMission(query(mission));

test('Windows discovers both providers only after native supervision and shell-free CLI preflight succeed', { timeout: 60000, skip: process.platform !== 'win32' }, async t => {
  const ctx = await setup(t, [['garden', 'claude']]);
  const providers = await probeWebProviders({ folder: ctx.bindings[0].folder, executables: ctx.executables, envSource: ctx.envSource });
  assert.deepEqual(providers, [{ id: 'codex', available: true, reason: 'ready' }, { id: 'claude', available: true, reason: 'ready' }]);
  assert.equal((await nativeEvents(ctx.events)).length, 0);
});

test('two project teams run mixed native protocols with isolated context, sessions, bridges and noninterrupting steering', { timeout: nativeTimeout(30000), skip: nativeSkip }, async t => {
  const ctx = await setup(t, undefined, (label, root) => [{ gate: join(root, `gate-${label}`) }]);
  const accepted = await Promise.all(ctx.bindings.map(binding => ctx.controllers.accept(start(binding))));
  const missions = accepted.map(item => item.mission);
  const first = await until(() => nativeEvents(ctx.events), events => events.filter(event => event.type === 'turn').length === 4, 'four independent native stand-ins');
  assert.equal(new Set(first.map(event => event.pid)).size, 4);
  assert.equal(new Set(first.map(event => event.sessionId)).size, 4);
  for (const binding of ctx.bindings) {
    const label = `${binding.target.projectId}-${binding.target.agentId}`;
    const event = first.find(item => item.cwd === binding.folder);
    assert.ok(event, `Own checkout for ${label}`);
    assert.equal(event.provider, binding.target.agentId);
    assert.equal(event.model, `${binding.target.agentId}-${binding.target.projectId}-synthetic`);
    assert.equal(event.home, ctx.envSource.HOME);
    assert.match(event.prompt, new RegExp(`Rules for ${binding.target.projectId}`));
    assert.match(event.prompt, new RegExp(`Persona ${label}`));
    assert.doesNotMatch(event.prompt, new RegExp(`Rules for ${binding.target.projectId === 'garden' ? 'park' : 'garden'}`));
    if (event.provider === 'claude') {
      assert.equal(event.prompt.split('Local development permissions:').length-1,1);
      assert.equal(event.claudeHome, ctx.envSource.CLAUDE_CONFIG_DIR);
      assert.equal(event.codexHome, null);
      assert.equal(event.instructions, `Synthetic instructions for ${label}.`);
      assert.deepEqual(event.permissions, { mode: 'acceptEdits', prompts: 'none', strictMcp: true, settingSources: '--setting-sources=' });
      assert.deepEqual(Object.keys(event.mcp.mcpServers), ['pilot']);
      assert.equal(event.mcp.mcpServers.pilot.headers.Authorization, `Bearer synthetic-${label}`);
    } else {
      assert.equal(event.codexHome, ctx.envSource.CODEX_HOME);
      assert.equal(event.claudeHome, null);
      assert.equal(event.bridgeToken, `synthetic-${label}`);
      assert.ok(Object.values(event.cliConfig).includes(JSON.stringify(binding.bridge.url)));
      assert.ok(JSON.parse(event.cliConfig.developer_instructions).startsWith(`Synthetic instructions for ${label}.`));
      assert.match(JSON.parse(event.cliConfig.developer_instructions), /Local development permissions/);
      assert.equal(JSON.parse(event.cliConfig.developer_instructions).split('Local development permissions:').length-1,1);
      assert.ok(!event.prompt.includes('Local development permissions:'));
      assert.equal(event.cliConfig.sandbox_mode, '"workspace-write"');
      assert.equal(event.cliConfig.approval_policy, '"on-request"');
      assert.equal(event.cliConfig.approvals_reviewer, '"auto_review"');
      for (const feature of ['hooks', 'apps', 'plugins', 'multi_agent', 'goals']) assert.equal(event.cliConfig[`features.${feature}`], 'false');
    }
  }
  await Promise.all(missions.map(mission => ctx.controllers.accept(command(mission, 'steer', { message: `Steering only ${mission.target.projectId}/${mission.target.agentId}.` }))));
  await sleep(60);
  assert.equal((await nativeEvents(ctx.events)).filter(event => event.type === 'turn').length, 4);
  for (const mission of missions) {
    const state = await inspect(ctx, mission)();
    assert.equal(state.steering[0].state, 'queued');
    assert.equal(state.outcomes.length, 0);
  }
  await Promise.all(ctx.bindings.map(binding => writeFile(join(ctx.root, `gate-${binding.target.projectId}-${binding.target.agentId}`), 'release')));
  for (const mission of missions) {
    const final = await until(inspect(ctx, mission), state => state.outcomes.length === 2, 'second native outcome');
    assert.equal(final.steering[0].state, 'applied');
    assert.equal(final.outcomes[1].outcome.delivery, 'acknowledged');
    assert.equal(final.outcomes[1].outcome.usage.provider, mission.execution.provider);
    assert.equal(final.outcomes[1].outcome.usage.tokens.input, 10);
    assert.equal(final.outcomes[1].outcome.usage.tokens.output, 3);
    assert.equal(final.outcomes[1].outcome.focus, `Checking ${mission.target.projectId}-${mission.target.agentId}.`);
    assert.match(final.outcomes[1].text, new RegExp(`Synthetic ${mission.target.projectId}-${mission.target.agentId} turn 2`));
  }
  const all = (await nativeEvents(ctx.events)).filter(event => event.type === 'turn');
  assert.equal(all.length, 8);
  assert.equal((await nativeEvents(ctx.events)).some(event => event.type === 'interrupt'), false);
  for (const binding of ctx.bindings) {
    const own = all.filter(event => event.cwd === binding.folder);
    assert.equal(own.length, 2); assert.equal(own[0].sessionId, own[1].sessionId);
    assert.match(own[1].prompt, new RegExp(`Steering only ${binding.target.projectId}/${binding.target.agentId}`));
    for (const other of ctx.bindings.filter(item => item !== binding)) assert.equal(own[1].prompt.includes(`Steering only ${other.target.projectId}/${other.target.agentId}`), false);
  }
});

test('stopping one native agent leaves both providers in other projects running', { timeout: nativeTimeout(30000), skip: nativeSkip }, async t => {
  const ctx = await setup(t, undefined, (label, root) => [{ gate: join(root, `gate-${label}`) }]);
  const missions = (await Promise.all(ctx.bindings.map(binding => ctx.controllers.accept(start(binding))))).map(item => item.mission);
  const events = await until(() => nativeEvents(ctx.events), items => items.length === 4, 'four active native turns');
  const stopped = missions[0];
  await ctx.controllers.accept(command(stopped, 'stop'));
  await until(inspect(ctx, stopped), state => state.state === 'stopped', 'one mission stopped');
  for (const event of events.filter(item => item.cwd !== ctx.bindings[0].folder)) assert.doesNotThrow(() => process.kill(event.pid, 0));
  for (const binding of ctx.bindings.slice(1)) await writeFile(join(ctx.root, `gate-${binding.target.projectId}-${binding.target.agentId}`), 'release');
  for (const mission of missions.slice(1)) {
    const final = await until(inspect(ctx, mission), state => state.outcomes.length === 1, 'other mission completed');
    assert.equal(final.state, 'waiting');
    assert.equal(final.outcomes[0].outcome.failed, false);
  }
});

test('submitted Codex steering without acknowledgement becomes uncertain and is not resent on retry or restart', { timeout: nativeTimeout(20000), skip: nativeSkip }, async t => {
  const ctx = await setup(t, [['garden', 'codex']], () => [{}, { uncertain: true }]);
  const initial = start(ctx.bindings[0]);
  const { mission } = await ctx.controllers.accept(initial);
  await until(inspect(ctx, mission), state => state.outcomes.length === 1, 'first acknowledged turn');
  const steering = command(mission, 'steer', { message: 'Synthetic instruction whose ACK is lost.' });
  await ctx.controllers.accept(steering);
  const uncertain = await until(inspect(ctx, mission), state => state.outcomes.length === 2, 'uncertain saved outcome');
  assert.equal(uncertain.steering[0].state, 'uncertain');
  assert.equal(uncertain.outcomes[1].outcome.delivery, 'submitted');
  assert.equal((await ctx.controllers.accept(steering)).created, false);
  await sleep(100);
  assert.equal((await nativeEvents(ctx.events)).filter(event => event.type === 'turn').length, 2);
  await ctx.controllers.close(); await ctx.store.close();
  const reopened = await openRuntimeStore({ directory: ctx.directory });
  const recovered = createRuntimeControllers({ store: reopened, adapterFactory: ctx.adapterFactory });
  try {
    assert.equal((await recovered.getMission(query(mission))).steering[0].state, 'uncertain');
    assert.equal((await recovered.accept(initial)).created, false);
    assert.equal((await recovered.accept(steering)).created, false);
    await sleep(100);
    assert.equal((await nativeEvents(ctx.events)).filter(event => event.type === 'turn').length, 2);
  } finally { await recovered.close(); await reopened.close(); }
});

// A job has no time limit. A start saved before 10 November 2026 still carries an end time; once it passes, the
// native turn keeps running, and after it finishes the next turn starts.
test('an old end time that passes neither kills a native turn nor holds the next one', { timeout: nativeTimeout(15000), skip: nativeSkip }, async t => {
  const ctx = await setup(t, [['park', 'codex']], (_label, root) => [
    { result: 'Synthetic follow-up is ready.\nWORK_NEXT: runnable' },
    { gate: join(root, 'released-after-end'), result: 'Finished past the old end time.\nWORK_NEXT: runnable' },
    { result: 'Synthetic third turn.\nWORK_NEXT: waiting' },
  ]);
  const initial = start(ctx.bindings[0]);
  initial.payload.deadlineAt = Date.now() + (process.platform === 'win32' ? 15000 : 2500);
  const { mission } = await ctx.controllers.accept(initial);
  const turns = async () => (await nativeEvents(ctx.events)).filter(event => event.type === 'turn');
  await until(turns, events => events.length === 2, 'active continuation before the old end time');
  await sleep(Math.max(0, initial.payload.deadlineAt - Date.now()) + 400);
  const running = await turns();
  assert.doesNotThrow(() => process.kill(running[1].pid, 0), 'the turn keeps running past the old end time');
  assert.notEqual((await inspect(ctx, mission)()).state, 'stopped');
  await writeFile(join(ctx.root, 'released-after-end'), 'release');
  await until(turns, events => events.length === 3, 'the next turn starts after the old end time');
  const saved = await inspect(ctx, mission)();
  assert.equal(saved.outcomes[1].outcome.interrupted, false);
  assert.equal(Object.hasOwn(saved, 'deadlineAt'), false);
});

test('native interactive and permission refusals stay refused without tool approval or another provider', { timeout: nativeTimeout(20000), skip: nativeSkip }, async t => {
  const ctx = await setup(t, [['garden', 'claude'], ['park', 'codex']], label => label.endsWith('claude') ? [{ permissionRefused: true }] : [{ interactive: true }]);
  const missions = (await Promise.all(ctx.bindings.map(binding => ctx.controllers.accept(start(binding))))).map(item => item.mission);
  for (const mission of missions) {
    const final = await until(inspect(ctx, mission), state => state.outcomes.length === 1, 'refusal outcome');
    assert.equal(final.outcomes[0].outcome.failed, true);
    assert.equal(final.outcomes[0].outcome.failureCode, mission.execution.provider === 'claude' ? 'permission_required' : 'native_interactive_request');
    assert.equal(final.outcomes[0].outcome.delivery, 'submitted');
    if (mission.execution.provider === 'claude') assert.deepEqual(final.outcomes[0].outcome.permissionDenials, { count: 1, tools: ['Bash'] });
  }
  const response = (await nativeEvents(ctx.events)).find(event => event.type === 'interactive-response');
  assert.equal(response?.result, undefined);
  assert.equal(response?.error.code, -32601);
  await sleep(100);
  assert.equal((await nativeEvents(ctx.events)).filter(event => event.type === 'turn').length, 2);
});

test('paused or unknown project state starts no native turn while another project runs', { timeout: nativeTimeout(20000), skip: nativeSkip }, async t => {
  let paused = true, unknown = true;
  const ctx = await setup(t, [['garden', 'claude'], ['park', 'codex'], ['park', 'claude']], undefined, fixtures => {
    fixtures.bindings[0].readProjectState = async () => ({ project: { started: true, paused, closed: false }, pending: 0, acknowledged: 0 });
    fixtures.bindings[1].readProjectState = async () => unknown ? null : ({ project: { started: true, paused: false, closed: false }, pending: 0, acknowledged: 0 });
  });
  const missions = (await Promise.all(ctx.bindings.map(binding => ctx.controllers.accept(start(binding))))).map(item => item.mission);
  await until(inspect(ctx, missions[2]), state => state.outcomes.length === 1, 'allowed project runs');
  await sleep(80);
  const before = await nativeEvents(ctx.events);
  assert.equal(before.filter(event => event.type === 'turn').length, 1);
  assert.equal(before[0].cwd, ctx.bindings[2].folder);
  assert.equal((await inspect(ctx, missions[0])()).outcomes.length, 0);
  assert.equal((await inspect(ctx, missions[1])()).outcomes.length, 0);
  paused = false; unknown = false;
  await Promise.all(missions.slice(0, 2).map(mission => ctx.controllers.accept(command(mission, 'steer', { message: 'Proceed only after the project allows work.' }))));
  for (const mission of missions.slice(0, 2)) {
    const final = await until(inspect(ctx, mission), state => state.outcomes.length >= 1 && state.steering[0]?.state==='applied', 'newly allowed project runs');
    assert.equal(final.steering[0].state, 'applied');
  }
  assert.ok((await nativeEvents(ctx.events)).filter(event => event.type === 'turn').length >= 3);
});
