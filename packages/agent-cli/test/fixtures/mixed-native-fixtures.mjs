import { createWorkerGuidance } from '../../src/worker-guidance.mjs';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// Fixed offline stand-ins for the native protocols, not model runners. Their
// only configuration is a synthetic file in each disposable working directory.
const nativeSource = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const args = process.argv.slice(2);
const provider = path.basename(process.argv[1]).replace(/\.cjs$/, '') === 'codex' ? 'codex' : 'claude';
if (args.includes('--version')) { console.log(provider === 'codex' ? 'codex-cli 0.160.0' : 'Claude Code synthetic'); process.exit(0); }
if (args.includes('login') && args.includes('status')) process.exit(0);
if (args.includes('auth') && args.includes('status')) { console.log(JSON.stringify({loggedIn:true})); process.exit(0); }
if (args.includes('mcp') && args.includes('list')) { console.log('[]'); process.exit(0); }
if (args.includes('execpolicy')) { const rules=fs.readFileSync(args[args.indexOf('--rules')+1],'utf8'); console.log(JSON.stringify(rules.includes('forbidden')?{decision:'forbidden',matchedRules:[{}]}:{matchedRules:[]})); process.exit(0); }
const config = JSON.parse(fs.readFileSync(path.join(process.cwd(), '.mixed-native.json'), 'utf8'));
if (provider !== config.provider) throw Error('Wrong provider executable');
const countPath = path.join(process.cwd(), '.mixed-turn-count');
const count = Number(fs.existsSync(countPath) ? fs.readFileSync(countPath, 'utf8') : 0) + 1;
fs.writeFileSync(countPath, String(count));
const behavior = config.turns[count - 1] || {};
const emit = value => console.log(JSON.stringify(value));
const at = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const append = value => fs.appendFileSync(config.events, JSON.stringify(value) + '\n');
const record = (prompt, sessionId, model, extras = {}) => append({ type: 'turn', provider, pid: process.pid, cwd: process.cwd(), prompt, sessionId, model, count, home: process.env.HOME, codexHome: process.env.CODEX_HOME || null, claudeHome: process.env.CLAUDE_CONFIG_DIR || null, ...extras });
const wait = async () => { while (behavior.gate && !fs.existsSync(behavior.gate)) await new Promise(resolve => setTimeout(resolve, 10)); };
const result = behavior.result || ('Synthetic ' + config.label + ' turn ' + count + '.\nWORK_NEXT: waiting');
if (provider === 'claude') {
 const sessionId = args.includes('--resume') ? at('--resume') : at('--session-id');
 if (behavior.missingSession && args.includes('--resume')) { append({ type: 'missing-session', provider, pid: process.pid, cwd: process.cwd(), sessionId }); console.error('No conversation found'); process.exit(1); }
 const mcp = JSON.parse(fs.readFileSync(at('--mcp-config'), 'utf8'));
 const instructions = fs.readFileSync(at('--append-system-prompt-file'), 'utf8');
 record(at('-p'), sessionId, at('--model'), { instructions, mcp, permissions: { mode: at('--permission-mode'), prompts: at('--permission-prompts'), strictMcp: args.includes('--strict-mcp-config'), settingSources: args.find(value => value.startsWith('--setting-sources=')) } });
 emit({ type: 'system', subtype: 'init', model: at('--model') || 'claude-synthetic' });
 if (!behavior.uncertain && !behavior.permissionRefused) emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'AGENT_STATUS="Checking ' + config.label + '."' }] } });
 (async () => { await wait();
  if (behavior.uncertain) return process.exit(0);
  if (behavior.permissionRefused) { emit({ type: 'result', is_error: true, num_turns: 0, result: '', errors: ['Permission denied: requires approval'], permission_denials: [{ tool_name: 'Bash' }] }); return; }
  emit({ type: 'result', is_error: false, num_turns: 1, session_id: sessionId, result, usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
 })();
} else {
 let thread;
 const cliConfig = Object.fromEntries(args.flatMap((value, index) => value === '-c' ? [args[index + 1].split(/=(.*)/s).slice(0, 2)] : []));
 const lines = readline.createInterface({ input: process.stdin });
 lines.on('line', line => {
  const request = JSON.parse(line);
  if (request.id === 99) append({ type: 'interactive-response', provider, error: request.error, result: request.result });
  if (request.method === 'initialize') emit({ id: request.id, result: {} });
  if (request.method === 'config/read') emit({id:request.id,result:{layers:[{name:{type:'project',dotCodexFolder:path.join(fs.realpathSync.native(request.params.cwd),'.codex')},config:{},version:'1'}]}});
  if (request.method === 'thread/start' || request.method === 'thread/resume') {
   thread = request.method === 'thread/resume' ? request.params.threadId : config.threadId;
   if (thread !== config.threadId || (request.method === 'thread/resume' && request.params.excludeTurns !== true)) throw Error('Wrong session or history requested');
   emit({ id: request.id, result: { thread: { id: thread }, modelProvider: 'openai', model: request.params.model || 'codex-synthetic' } });
   config.selectedModel = request.params.model;
  }
  if (request.method === 'turn/start') {
   record(request.params.input[0].text, thread, config.selectedModel, { cliConfig, bridgeToken: process.env.PILOT_BRIDGE_TOKEN });
   if (behavior.uncertain) { lines.close(); process.exit(0); }
   if (behavior.interactive) { emit({ id: 99, method: 'item/tool/requestUserInput', params: { threadId: thread } }); return; }
   const turnId = config.threadId + '-' + count;
   emit({ id: request.id, result: { turn: { id: turnId } } });
   emit({ method: 'turn/started', params: { threadId: thread, turn: { id: turnId } } });
   emit({ method: 'item/completed', params: { threadId: thread, turnId, item: { id: 'status', type: 'agentMessage', text: 'AGENT_STATUS="Checking ' + config.label + '."' } } });
   (async () => { await wait();
    emit({ method: 'thread/tokenUsage/updated', params: { threadId: thread, turnId, tokenUsage: { total: { inputTokens: count * 10, outputTokens: count * 3, cachedInputTokens: 0, cacheWriteInputTokens: 0 } } } });
    emit({ method: 'item/completed', params: { threadId: thread, turnId, item: { id: 'result', type: 'agentMessage', text: result } } });
    emit({ method: 'turn/completed', params: { threadId: thread, turn: { id: turnId, status: 'completed' } } });
   })();
  }
  if (request.method === 'turn/interrupt') {
   append({ type: 'interrupt', provider, label: config.label });
   emit({ method: 'turn/completed', params: { threadId: thread, turn: { id: request.params.turnId, status: 'interrupted' } } });
  }
 }).on('close', () => process.exit(0));
}
`;

export async function makeMixedNativeFixtures(root, selections = [
  ['garden', 'claude'], ['garden', 'codex'], ['park', 'claude'], ['park', 'codex'],
], turns = () => []) {
  const bin = join(root, 'bin'), home = join(root, 'home');
  const codexHome = join(root, 'codex-config'), claudeHome = join(root, 'claude-config');
  await Promise.all([bin, home, codexHome, claudeHome].map(path => mkdir(path, { recursive: true, mode: 0o700 })));
  const windows = process.platform === 'win32';
  const executables = Object.fromEntries(['claude', 'codex'].map(provider => [provider, join(bin, provider + (windows ? '.cmd' : ''))]));
  for (const [provider, path] of Object.entries(executables)) {
    if (windows) {
      await writeFile(join(bin, `${provider}.cjs`), nativeSource);
      await writeFile(path, `@ECHO off\r\n"%_prog%" "%dp0%\\${provider}.cjs" %*\r\n`);
    } else await writeFile(path, `#!${process.execPath}\n${nativeSource}`, { mode: 0o700 });
  }
  const events = join(root, 'events.jsonl');
  const envSource = { ...(windows ? Object.fromEntries(['SystemRoot','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP'].filter(key=>process.env[key]).map(key=>[key,process.env[key]])) : {}), PATH: windows ? process.env.PATH : '/usr/bin:/bin', HOME: home, CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeHome };
  const bindings = [];
  for (const [projectId, provider] of selections) {
    const label = `${projectId}-${provider}`, folder = join(root, 'checkouts', label), stateDir = join(root, 'native-state', label);
    await Promise.all([folder, stateDir].map(path => mkdir(path, { recursive: true, mode: 0o700 })));
    execFileSync('git', ['init', '-q', folder], { env: envSource, stdio: 'ignore' });
    execFileSync('git', ['-C', folder, 'remote', 'add', 'origin', `https://github.com/synthetic/${projectId}.git`], { env: envSource, stdio: 'ignore' });
    const target = { site: 'https://synthetic.example', ownerId: 'synthetic-owner', projectId, agentId: provider };
    const bridge = { token: `synthetic-${label}`, url: `http://127.0.0.1:12345/worker/${randomUUID().replaceAll('-', '')}/mcp`, headers: { Authorization: `Bearer synthetic-${label}` }, revoke: async () => {} };
    await writeFile(join(stateDir, 'instructions.md'), `Synthetic instructions for ${label}.`, { mode: 0o600 });
    await writeFile(join(stateDir, 'worker-guides.json'), JSON.stringify(createWorkerGuidance({
      core: `Synthetic instructions for ${label}.`, guideRevision: 1,
      sections: { 'project-work': `Synthetic collaboration for ${label}.`, 'updates-and-help': `Synthetic reporting for ${label}.` },
    })), { mode: 0o600 });
    await writeFile(join(stateDir, 'mcp.json'), JSON.stringify({ mcpServers: { unexpected: { type: 'http', url: 'https://must-not-inherit.synthetic/mcp' } } }), { mode: 0o600 });
    await writeFile(join(folder, '.mixed-native.json'), JSON.stringify({ provider, label, events, threadId: randomUUID(), turns: turns(label, root) }), { mode: 0o600 });
    bindings.push({ target, readProjectState: async () => ({ project: { started: true, paused: false, closed: false }, pending: 0, acknowledged: 0 }), repository: `synthetic/${projectId}`, folder, stateDir, bridge, createBridge: async () => bridge,
      prepareParticipation: async () => ({ project: { name: `Synthetic ${projectId}`, rules: `Rules for ${projectId}` }, persona: `Persona ${label}` }) });
  }
  return { bindings, executables, envSource, events, registryRoot: join(root, 'ownership') };
}

export async function nativeEvents(path) {
  try { return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
