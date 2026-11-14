import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readRunJournal } from '../src/run-journal.mjs';
const journalIdentity = provider => ({ target: { site:'http://127.0.0.1:8787', ownerId:'synthetic-owner', projectId:'synthetic-project', agentId:'synthetic-agent' }, missionId:randomUUID(), generation:1, provider, model:null });
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalWorkerAdapter } from '../src/native-worker-adapter.mjs';
import { readPrivate, writePrivate } from '../src/state.mjs';
import { createWorkerGuidance } from '../src/worker-guidance.mjs';
import { execFileSync } from 'node:child_process';

test('actual adapter and process guard resume one thread, request no history and acknowledge each submitted prompt (fake CLI, no model)', { timeout: 10000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'mlswarm-fake-native-')), stateDir = join(root, 'state'), folder = join(root, 'repo'), bin = join(root, 'bin');
  for (const path of [stateDir, folder, bin]) mkdirSync(path, { mode: 0o700 });
  execFileSync('git', ['-C', folder, 'init', '--quiet']);
  writeFileSync(join(stateDir, 'instructions.md'), 'Synthetic native protocol verification', { mode: 0o600 });
  const guidance=revision=>createWorkerGuidance({core:'Synthetic native protocol verification',guideRevision:revision,
    sections:{'project-work':`Synthetic work ${revision}`,'updates-and-help':`Synthetic updates ${revision}`}});
  writePrivate(join(stateDir,'worker-guides.json'),guidance(1));
  const policies = join(root, 'policies.jsonl');
  writeFileSync(join(bin, 'codex'), `#!${process.execPath}
import { createInterface } from 'node:readline';
import * as fs from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('codex-cli 0.160.0'); process.exit(0); }
if (args.includes('status')) process.exit(0);
if (args.includes('list')) { console.log('[]'); process.exit(0); }
if (args.includes('execpolicy')) { const fs = await import('node:fs'); const rules=fs.readFileSync(args[args.indexOf('--rules')+1],'utf8'); console.log(JSON.stringify(rules.includes('forbidden')?{decision:'forbidden',matchedRules:[{}]}:{matchedRules:[]})); process.exit(0); }
const thread = '11111111-1111-4111-8111-111111111111', turn = '22222222-2222-4222-8222-222222222222';
const emit = value => console.log(JSON.stringify(value));
createInterface({input:process.stdin}).on('line', line => {
 const v = JSON.parse(line);
 if (v.method === 'initialize') emit({id:v.id,result:{}});
 if (v.method === 'config/read') emit({id:v.id,result:{layers:[{name:{type:'project',dotCodexFolder:fs.realpathSync.native(v.params.cwd)+'/.codex'},config:{},version:'1'}]}});
 if (v.method === 'thread/start' || v.method === 'thread/resume') {
  const ruleFile=${JSON.stringify(join(folder,'.codex','rules','mlswarm-worker-merge.rules'))}; fs.appendFileSync(${JSON.stringify(policies)},JSON.stringify({rules:fs.existsSync(ruleFile)?fs.readFileSync(ruleFile,'utf8'):'',method:v.method})+'\\n');
  if (v.method === 'thread/resume' && (v.params.excludeTurns !== true || v.params.threadId !== thread)) throw Error('Unexpected resume identity/history request');
  emit({id:v.id,result:{thread:{id:thread},modelProvider:'openai',model:'gpt-6.1-sol'}});
 }
 if (v.method === 'turn/start') {
  emit({id:v.id,result:{turn:{id:turn}}});
  emit({method:'turn/started',params:{threadId:thread,turn:{id:turn}}});
  emit({method:'item/completed',params:{threadId:thread,turnId:turn,item:{id:'focus',type:'agentMessage',text:'AGENT_STATUS="Checking the synthetic preview."'}}});
  emit({method:'item/completed',params:{threadId:thread,turnId:turn,item:{id:'message',type:'agentMessage',text:'Synthetic complete.\\nWORK_NEXT: waiting'}}});
  emit({method:'turn/completed',params:{threadId:thread,turn:{id:turn,status:'completed'}}});
 }
}).on('close',()=>process.exit(0));
`, { mode: 0o700 });
  const native = { executables: { codex: join(bin, 'codex') }, envSource: { HOME: root, PATH: '/usr/bin:/bin' } };
  let submitted = 0, started = 0, mergeApproval = 'humans'; const statuses = []; const identity = journalIdentity('codex');
  try {
    const adapterOptions = { client: 'codex', folder, stateDir, ...native, journalIdentity: identity,
      bridge: { url: 'http://127.0.0.1:12345/mcp', headers: { Authorization: 'Bearer synthetic-only' } },
      scope: 'Synthetic verification', prepareParticipation: async () => ({project:{mergeApproval},persona:{text:'',revision:0}}) };
    let adapter = await createLocalWorkerAdapter(adapterOptions);
    const run = () => adapter.run({ prompt: 'Synthetic verification only', signal: new AbortController().signal,
      deadline: Date.now() + 5000, onPromptSubmitted: () => submitted++, onTurnStarted: () => started++, onStatus: value => statuses.push(value) });
    const first = await run(); mergeApproval = 'anyone'; const second = await run();
    // Reconstruct the adapter from saved session/core/guides, then resume the same thread.
    adapter = await createLocalWorkerAdapter(adapterOptions);
    mergeApproval = 'humans'; const third = await run(); mergeApproval = 'other_agents'; const fourth = await run();
    mergeApproval = 'agent_review'; const fifth = await run(); mergeApproval = 'anyone'; const sixth = await run();
    for (const result of [third,fourth,fifth,sixth]) assert.equal(result.failed,false);
    assert.equal(Boolean(first.failed), false); assert.equal(Boolean(second.failed), false);
    assert.equal(second.delivery, 'acknowledged'); assert.equal(second.usage.model, 'gpt-6.1-sol');
    assert.equal(second.text, 'Synthetic complete.\nWORK_NEXT: waiting');
    assert.equal(submitted, 6); assert.equal(started, 6);
    assert.deepEqual(statuses, Array(6).fill('Checking the synthetic preview.'));
    const observed=readFileSync(policies,'utf8').trim().split('\n').map(line=>JSON.parse(line));
    assert.deepEqual(observed.map(value=>value.rules.includes('forbidden')),[true,false,true,false,false,false]);
    assert.deepEqual(observed.map(value=>value.method),['thread/start',...Array(5).fill('thread/resume')]);
    assert.equal(existsSync(join(folder,'.codex','rules','mlswarm-worker-merge.rules')),false);
    assert.equal(readPrivate(join(stateDir, 'model-session.json'), true).id, '11111111-1111-4111-8111-111111111111');
    const journal = readRunJournal({directory:stateDir,identity});
    assert.equal(journal.availability,'available'); assert.deepEqual(journal.interruptedAttempts,[]);
    assert.equal(journal.records.filter(r=>r.kind==='attempt_started').length,6);
    assert.equal(journal.records.filter(r=>r.kind==='assistant_text').length,12);
    assert.ok(journal.records.some(r=>r.kind==='session')); assert.equal(second.evidence.availability,'available');
    assert.equal(second.diagnostics.exit_code, 0); assert.equal(second.diagnostics.guard_exit_code, 0);
    const savedSession=readPrivate(join(stateDir,'model-session.json'),true);
    writePrivate(join(stateDir,'worker-guides.json'),guidance(2));
    await assert.rejects(createLocalWorkerAdapter(adapterOptions),/different approved work/);
    assert.deepEqual(readPrivate(join(stateDir,'model-session.json'),true),savedSession);
    assert.equal(readFileSync(policies,'utf8').trim().split('\n').length,6,'a changed guide cannot silently start or resume a turn');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Claude submission is persisted before native launch, and a failed persistence callback prevents execution (fake CLI, no model)', { timeout: 10000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'mlswarm-fake-claude-')), stateDir = join(root, 'state'), folder = join(root, 'repo'), bin = join(root, 'bin');
  for (const path of [stateDir, folder, bin]) mkdirSync(path, { mode: 0o700 });
  const marker = join(root, 'native-launched');
  writeFileSync(join(stateDir, 'instructions.md'), 'Synthetic Claude startup check', { mode: 0o600 });
  writeFileSync(join(bin, 'claude'), `#!${process.execPath}
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('Claude Code synthetic'); process.exit(0); }
fs.writeFileSync(${JSON.stringify(marker)}, 'started');
console.log(JSON.stringify({type:'assistant',message:{content:[]}}));
console.log(JSON.stringify({type:'result',is_error:false,num_turns:1,result:'Synthetic result'}));
`, { mode: 0o700 });
  const native = { executables: { claude: join(bin, 'claude') }, envSource: { HOME: root, PATH: '/usr/bin:/bin' } };
  try {
    const adapter = await createLocalWorkerAdapter({ client: 'claude', folder, stateDir, ...native, journalIdentity: journalIdentity('claude'), bridge: {},
      scope: 'Synthetic startup verification', prepareParticipation: async () => null });
    const options = { prompt: 'Synthetic only', signal: new AbortController().signal, deadline: Date.now() + 5000 };
    const refused = await adapter.run({ ...options, onPromptSubmitted: async () => {
      assert.equal(existsSync(marker), false); await Promise.resolve(); throw new Error('Synthetic persistence refusal');
    } });
    assert.equal(refused.failureCode, 'private_state_failure'); assert.equal(refused.delivery, 'not_submitted');
    assert.equal(refused.cleanupConfirmed, true);
    assert.equal(existsSync(marker), false);
    let submitted = 0, accepted = 0;
    const result = await adapter.run({ ...options, onPromptSubmitted: async () => { await Promise.resolve(); assert.equal(existsSync(marker), false); submitted++; }, onTurnStarted: async () => { await Promise.resolve(); accepted++; } });
    assert.equal(submitted, 1); assert.equal(accepted, 1); assert.equal(existsSync(marker), true);
    assert.equal(Boolean(result.failed), false); assert.equal(result.delivery, 'acknowledged');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a Claude turn ends at its result even when a background command keeps the client alive (fake CLI, no model)', { timeout: 30000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'mlswarm-fake-claude-')), stateDir = join(root, 'state'), folder = join(root, 'repo'), bin = join(root, 'bin');
  for (const path of [stateDir, folder, bin]) mkdirSync(path, { mode: 0o700 });
  writeFileSync(join(stateDir, 'instructions.md'), 'Synthetic Claude startup check', { mode: 0o600 });
  writeFileSync(join(bin, 'claude'), `#!${process.execPath}
if (process.argv.includes('--version')) { console.log('Claude Code synthetic'); process.exit(0); }
console.log(JSON.stringify({type:'assistant',message:{content:[]}}));
console.log(JSON.stringify({type:'result',is_error:false,num_turns:1,result:'Synthetic result'}));
setInterval(() => {}, 1000);
`, { mode: 0o700 });
  const native = { executables: { claude: join(bin, 'claude') }, envSource: { HOME: root, PATH: '/usr/bin:/bin' } };
  try {
    const adapter = await createLocalWorkerAdapter({ client: 'claude', folder, stateDir, ...native, journalIdentity: journalIdentity('claude'), bridge: {},
      scope: 'Synthetic startup verification', prepareParticipation: async () => null });
    const started = Date.now();
    const result = await adapter.run({ prompt: 'Synthetic only', signal: new AbortController().signal, deadline: Date.now() + 60000 });
    assert.ok(Date.now() - started < 20000, 'the turn does not wait for the lingering client');
    assert.equal(Boolean(result.failed), false); assert.equal(Boolean(result.interrupted), false);
    assert.equal(result.delivery, 'acknowledged'); assert.equal(result.cleanupConfirmed, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the Card merge setting decides each turn whether gh pr merge is denied (fake Claude, no model)', { timeout: 10000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'mlswarm-merge-card-')), stateDir = join(root, 'state'), folder = join(root, 'repo'), bin = join(root, 'bin');
  for (const path of [stateDir, folder, bin]) mkdirSync(path, { mode: 0o700 });
  const seen = join(root, 'seen.json');
  writeFileSync(join(stateDir, 'instructions.md'), 'Synthetic merge policy check', { mode: 0o600 });
  writeFileSync(join(bin, 'claude'), `#!${process.execPath}
const fs = require('node:fs'), args = process.argv;
if (args.includes('--version')) { console.log('Claude Code synthetic'); process.exit(0); }
const settings = JSON.parse(fs.readFileSync(args[args.indexOf('--settings') + 1], 'utf8'));
fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ deny: settings.permissions.deny, prompt: args[args.indexOf('-p') + 1] }));
console.log(JSON.stringify({type:'result',is_error:false,num_turns:1,result:'Synthetic result'}));
`, { mode: 0o700 });
  let mergeApproval = 'anyone';
  const project = () => ({ name: 'Park', mission: 'Build a map', rules: 'Small changes', repoUrl: 'https://github.com/example/park', mergeApproval, cardVersion: 1 });
  try {
    const adapter = await createLocalWorkerAdapter({ client: 'claude', folder, stateDir, executables: { claude: join(bin, 'claude') }, envSource: { HOME: root, PATH: '/usr/bin:/bin' },
      journalIdentity: journalIdentity('claude'), bridge: {}, scope: 'Synthetic merge policy', prepareParticipation: async () => ({ project: project(), persona: { text: '', revision: 0 } }) });
    const turn = async () => { await adapter.run({ prompt: 'Synthetic only', signal: new AbortController().signal, deadline: Date.now() + 5000 }); return JSON.parse(readFileSync(seen, 'utf8')); };
    const open = await turn();
    assert.equal(open.deny.includes('Bash(gh pr merge *)'), false);
    assert.ok(open.deny.includes('Bash(git merge *)') && open.deny.includes('Bash(npm publish *)'));
    // Bare forms merge the upstream branch too; deny them like bare gh pr merge.
    assert.ok(open.deny.includes('Bash(git merge)') && open.deny.includes('Bash(git pull)'));
    assert.match(open.prompt, /you may merge it with gh pr merge/);
    // The sandbox stops Chromium's multi-process start on macOS; the worker is told the flag that works.
    assert.match(open.prompt, /headless Chromium with --single-process/);
    assert.match(open.prompt, /share its temporary folder: create temporary files with mktemp/);
    for (const mode of ['humans']) {
      mergeApproval = mode;
      const closed = await turn();
      assert.ok(closed.deny.includes('Bash(gh pr merge *)'));
      assert.doesNotMatch(closed.prompt, /you may merge it with gh pr merge/);
      assert.match(closed.prompt, /selects Other member approval, Agent peer review or Agent discretion in the Merging tab/);
    }
    mergeApproval = 'other_agents';
    const other = await turn(); assert.equal(other.deny.includes('Bash(gh pr merge *)'), false);
    assert.match(other.prompt, /agent of a different member/);
    // Agent peer review lifts the deny but tells the agent to merge only another agent's approved work, naming both.
    mergeApproval = 'agent_review';
    const buddy = await turn();
    assert.equal(buddy.deny.includes('Bash(gh pr merge *)'), false);
    assert.match(buddy.prompt, /never merge your own pull request/);
    assert.match(buddy.prompt, /names you as the merging agent and the agent who approved/);
    // A resumed conversation holds what has not changed: the next turn names those blocks instead of repeating them.
    const same = await turn();
    assert.match(same.prompt, /## Permissions\n\nUnchanged since you last got it in full in this conversation; it still applies\.\n/);
    assert.match(same.prompt, /## Project card\n\nUnchanged since you last got it in full/);
    assert.doesNotMatch(same.prompt, /never merge your own pull request|> Build a map/);
    assert.match(same.prompt, /Native tasks are ON/);
    assert.ok(same.prompt.length < buddy.prompt.length / 2);
    // Every tenth turn carries everything again, in case the client summarized its history.
    let full = 0; for (let n = 0; n < 10; n += 1) if (/never merge your own pull request/.test((await turn()).prompt)) full += 1;
    assert.equal(full, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
