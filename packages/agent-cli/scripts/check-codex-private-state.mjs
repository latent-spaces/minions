// Model-free native acceptance: only newly created synthetic files and an isolated client home.
// No turn/start, prompts, provider sign-in, personal config or credentials are used.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { childEnv, createProvider, workerPrivatePaths, workerCodexProfile } from '../runtime/providers.mjs';
import { directInvocation } from './context-overhead-direct.mjs';
import { resolveWindowsCommand } from '../src/windows-command.mjs';

const executable = process.argv[2] ?? 'codex';
if (process.argv.length > 3) throw new Error('Usage: node packages/agent-cli/scripts/check-codex-private-state.mjs [codex executable]');
const root = await realpath(await mkdtemp(join(tmpdir(), 'minions-codex-private-')));
const home = join(root, 'native'), folder = join(root, 'checkout'), shared = join(root, 'shared');
const stateDir = join(root, 'engine', 'connector-service', 'agents', 'synthetic');
const credentials = join(root, 'credentials');
const env = { ...childEnv('codex', process.env), HOME: root, USERPROFILE: root, CODEX_HOME: home };
for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'GH_CONFIG_DIR']) delete env[key];
const inline = value => typeof value === 'object' && value !== null
  ? Array.isArray(value) ? `[${value.map(inline).join(',')}]` : `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}=${inline(item)}`).join(',')}}`
  : JSON.stringify(value);
const services = [];
async function open(args) {
  const command = process.platform === 'win32' ? resolveWindowsCommand(executable, args, { env, cwd: folder }) : { command: executable, args };
  const child = spawn(command.command, command.args, { cwd: folder, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const waiting = new Map(); let next = 0;
  child.stderr.resume();
  child.stdin.on('error', () => {});
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    try { const value = JSON.parse(line); waiting.get(value.id)?.(value); } catch { /* Only bounded RPC replies matter. */ }
  });
  const call = async (method, params) => {
    assert.ok(['initialize', 'config/read', 'thread/start', 'thread/inject_items', 'thread/resume', 'command/exec'].includes(method), 'No model methods are allowed');
    const id = ++next;
    const reply = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`Native ${method} timed out`)); }, 15_000);
      waiting.set(id, value => { clearTimeout(timer); waiting.delete(id); resolve(value); });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
    assert.equal(reply.error, undefined, `${method}: ${reply.error?.message}`);
    return reply.result;
  };
  const closed = once(child, 'close');
  services.push(async () => {
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
    try { await closed; } finally { clearTimeout(timer); lines.close(); }
  });
  await call('initialize', { clientInfo: { name: 'minions_synthetic_permissions', version: '1' }, capabilities: { experimentalApi: true } });
  child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
  return call;
}
let server;
try {
  for (const directory of [home, folder, shared, stateDir, credentials, join(root, '.minions'), join(folder, '.git'), join(shared, '.git')]) await mkdir(directory, { recursive: true });
  await writeFile(join(home, 'config.toml'), `sandbox_mode="workspace-write"\n[sandbox_workspace_write]\nnetwork_access=true\nwritable_roots=[${JSON.stringify(shared)}]\nexclude_slash_tmp=true\nexclude_tmpdir_env_var=true\n`);
  const instructionsFile = join(stateDir, 'instructions.md'); await writeFile(instructionsFile, '');
  for (const file of [join(folder, '.git', 'config'), join(shared, '.git', 'config')]) await writeFile(file, 'synthetic');
  const privatePaths = workerPrivatePaths({ stateDir, folder, userHome: root, envSource: { MINIONS_CREDENTIAL_HOME: credentials } });
  for (const path of privatePaths) { await mkdir(path, { recursive: true }); await writeFile(join(path, 'sentinel'), 'synthetic private content'); }
  const linked = join(folder, 'private-alias'); await symlink(credentials, linked, process.platform === 'win32' ? 'junction' : 'dir');
  const provider = createProvider('codex', { codex: executable, repoDir: folder }, { envSource: env });
  const session = provider.newSession('synthetic', folder);
  const makeInvocation = async resuming => directInvocation(await provider.invocation({ prompt: '', instructionsFile, privatePaths, permissionGuidance: '', bridge: { url: 'http://127.0.0.1:1/unused', headers: { Authorization: 'Bearer synthetic-unused' } }, session, resuming, repoDir: folder, clientVersion: 'synthetic' }), session);
  const invocation = await makeInvocation(false);
  assert.equal(invocation.args.some(arg => arg.startsWith('sandbox_mode=')), false);
  const call = await open(invocation.args);
  const config = (await call('config/read', { cwd: folder, includeLayers: false })).config;
  const started = await call('thread/start', invocation.rpc.prepareThread(config));
  assert.equal(started.activePermissionProfile?.id, invocation.rpc.permissionProfile);
  assert.equal(started.approvalPolicy, 'on-request'); assert.equal(started.approvalsReviewer, 'auto_review');
  session.id = started.thread.id;
  // Persist synthetic history without submitting a model turn, so Codex has a rollout to resume.
  await call('thread/inject_items', { threadId: session.id, items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Synthetic saved history; no model turn.' }] }] });
  // Each production turn starts a fresh app-server; an already-loaded native thread retains its active profile.
  await services.pop()();
  const resume = await makeInvocation(true);
  const resumeCall = await open(resume.args);
  const resumed = await resumeCall('thread/resume', resume.rpc.prepareThread((await resumeCall('config/read', { cwd: folder, includeLayers: false })).config));
  assert.equal(resumed.thread.id, session.id); assert.equal(resumed.activePermissionProfile?.id, resume.rpc.permissionProfile);
  assert.equal(resumed.approvalPolicy, 'on-request'); assert.equal(resumed.approvalsReviewer, 'auto_review');

  server = createServer((_req, response) => response.end('synthetic network'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const enabled of [true, false]) {
    const profile = workerCodexProfile({ sandbox_workspace_write: { ...config.sandbox_workspace_write, network_access: enabled } }, privatePaths);
    const execute = await open(['app-server', '--stdio', '--strict-config', '-c', `permissions.synthetic=${inline(profile)}`]);
    const script = `const fs=require('node:fs'),assert=require('node:assert/strict');
      const denied=file=>assert.throws(()=>fs.readFileSync(file),e=>['EACCES','EPERM'].includes(e.code));
      for(const path of ${JSON.stringify([...privatePaths, linked])})denied(require('node:path').join(path,'sentinel'));
      fs.writeFileSync(${JSON.stringify(join(folder, `written-${enabled}`))},'ok');
      fs.writeFileSync(${JSON.stringify(join(shared, `written-${enabled}`))},'ok');
      for(const file of ${JSON.stringify([join(folder, '.git', 'config'), join(shared, '.git', 'config'), join(root, 'excluded-temp')])})assert.throws(()=>fs.writeFileSync(file,'blocked'),e=>['EACCES','EPERM'].includes(e.code));
      fetch(${JSON.stringify(origin)},{signal:AbortSignal.timeout(1500)}).then(r=>r.text()).then(()=>true,()=>false).then(reached=>assert.equal(reached,${enabled})).then(()=>console.log('synthetic checks passed'));`;
    const result = await execute('command/exec', { command: [process.execPath, '-e', script], cwd: folder, permissionProfile: 'synthetic', timeoutMs: 10_000, outputBytesCap: 2000 });
    assert.equal(result.exitCode, 0, result.stderr); assert.match(result.stdout, /synthetic checks passed/);
  }
  console.log(`PASS: ${process.platform}; native start/resume profile confirmation, private and symlink reads denied, workspace/shared writes retained, Git/temp protections and both network settings; zero model turns.`);
} finally {
  for (const close of services.reverse()) await close();
  if (server) await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
