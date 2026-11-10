// Explicit native validation only: no turn/start, models, credentials or GitHub calls.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { codexMergeRules } from '../runtime/providers.mjs';
import { createCodexMergePolicy } from '../src/codex-merge-policy.mjs';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'mlswarm-real-native-rules-'))), folder = join(root, 'checkout with spaces'), stateDir = join(root, 'state'), home = join(root, 'codex-home');
for (const path of [folder, stateDir, home]) mkdirSync(path, { mode: 0o700 });
execFileSync('git', ['-C', folder, 'init', '--quiet']);
const policy = createCodexMergePolicy({ folder, stateDir });
async function inspect(mode, threadId) {
  if (mode === 'humans') await policy.prepare(codexMergeRules(mode)); else await policy.cleanup();
  const checkFile = join(stateDir, 'check.rules'); writeFileSync(checkFile, codexMergeRules(mode));
  for (const suffix of [[], ['1']]) {
    const checked = JSON.parse(execFileSync('codex', ['execpolicy', 'check', '--rules', checkFile, '--', 'gh', 'pr', 'merge', ...suffix], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    assert.equal(checked.decision === 'forbidden', mode === 'humans');
  }
  const args = ['app-server', '--stdio', '--strict-config', '-c', 'features.hooks=false', '-c', 'features.apps=false', '-c', 'features.plugins=false', '-c', 'features.multi_agent=false'];
  if (mode === 'humans') args.push('-c', `projects={${JSON.stringify(folder)}={trust_level="trusted"}}`);
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['PATH','PATHEXT','SYSTEMROOT','WINDIR','TEMP','TMP','TMPDIR','USERPROFILE','APPDATA','LOCALAPPDATA'].includes(key.toUpperCase())));
  const child = spawn('codex', args, { cwd: folder, env: { ...environment, HOME: home, CODEX_HOME: home, RUST_LOG: 'codex_core::exec_policy=trace' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const out = createInterface({ input: child.stdout }), errors = createInterface({ input: child.stderr });
  const policyEvents = []; let nativeId;
  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Native metadata validation timed out.')), 15000);
    child.once('error', reject); child.once('exit', code => { if (!nativeId) reject(new Error(`Native metadata process exited ${code}.`)); });
    errors.on('line', line => { try { const event = JSON.parse(line); if (event.target === 'codex_core::exec_policy' && event.fields?.rules) policyEvents.push(event.fields.rules); } catch { if (line.includes('rules_by_program:')) policyEvents.push(line); } });
    const send = value => child.stdin.write(JSON.stringify(value) + '\n');
    out.on('line', line => {
      try {
        const value = JSON.parse(line); if (value.error) throw new Error(`Native metadata request ${value.id} failed.`);
        if (value.id === 1) { send({ method: 'initialized' }); send({ id: 4, method: 'config/read', params: { cwd: folder, includeLayers: true } }); }
        if (value.id === 4) {
          if (mode === 'humans') assert.ok(value.result.layers.some(layer => layer.name?.type === 'project' && layer.name.dotCodexFolder === join(folder, '.codex') && layer.disabledReason == null));
          send({ id: 2, method: threadId ? 'thread/resume' : 'thread/start', params: { cwd: folder, model: 'gpt-5.4', ...(threadId ? { threadId, excludeTurns: true } : {}) } });
        }
        if (value.id === 2) { nativeId = value.result.thread.id; if (threadId) assert.equal(nativeId, threadId); clearTimeout(timer); resolve(nativeId); }
      } catch (error) { clearTimeout(timer); reject(error); }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'mlswarm_no_model_policy_check', version: '1' } } });
  });
  let id;
  try { id = await result; }
  finally { if (child.exitCode === null && child.signalCode === null) { const closed = new Promise(resolve => child.once('close', resolve)); child.kill(); await closed; } out.close(); errors.close(); await policy.cleanup(); }
  assert.ok(policyEvents.length > 0, 'Native thread loaded an execution policy.');
  assert.equal(policyEvents.some(value => value.includes('Forbidden') && value.includes('Single("merge")')), mode === 'humans');
  return id;
}
try {
  for (const mode of ['humans', 'anyone', 'humans', 'other_agents', 'agent_review']) await inspect(mode);
  console.log('Real Codex native rule loading and evaluation passed for all modes; no model turn sent. Cross-process resume needs a saved turn and is covered separately with fake clients.');
} finally { await policy.cleanup(); rmSync(root, { recursive: true, force: true }); }
