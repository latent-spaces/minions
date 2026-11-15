import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareSupervisedModel } from '../src/model-guard.mjs';
import { probeWindowsSupervision, stopWindowsMission } from '../src/windows-supervision.mjs';
import { probeWebProviders } from '../src/service/web-agent-starts.mjs';

const native = { skip: process.platform !== 'win32', timeout: 90000 };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, predicate, timeout = 45000) {
  for (const end = Date.now() + timeout; Date.now() < end;) {
    const value = await read(); if (predicate(value)) return value; await wait(25);
  }
  assert.fail('Windows worker lifecycle evidence did not arrive.');
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };

test('Windows readiness refuses missing supervision capabilities before probing coding clients', async () => {
  const providers = await probeWebProviders({ platform: 'win32', envSource: {}, executables: { claude: 'must-not-start', codex: 'must-not-start' } });
  assert.deepEqual(providers, [{ id: 'codex', available: false, reason: 'unavailable' }, { id: 'claude', available: false, reason: 'unavailable' }]);
});
async function start(t, args, { deadline = Date.now() + 60000, mark = randomBytes(16).toString('hex'), launchByAt = null, command = process.execPath } = {}) {
  const guard = prepareSupervisedModel({ cwd: tmpdir(), env: { ...process.env, MINIONS_MISSION_MARK: mark }, stdio: ['pipe', 'pipe', 'pipe'], deadline, launchByAt });
  const messages = []; let output = '', closed = false;
  guard.on('message', message => messages.push(message)); guard.on('error', () => {});
  guard.stdout.on('data', chunk => { output += chunk; }); guard.stderr.resume();
  const ended = once(guard, 'close').then(value => { closed = true; return value; });
  t.after(async () => { if (!closed) { guard.kill('SIGKILL'); await ended; } await stopWindowsMission(mark); });
  guard.authorize(command, args);
  return { guard, mark, messages, ended, output: () => output, waitStarted: () => until(() => messages.find(m => m.nativeStarted)?.nativeStarted, Boolean) };
}

test('Windows job helper probes kernel containment without starting a model', native, async () => {
  await probeWindowsSupervision();
});

test('Windows forwards RPC bytes and preserves literal command arguments without a shell', native, async t => {
  const args = ['space here', '"quote"', '%USERNAME%', '$env:HOME', '`ignored`', '&|<>', 'line\nbreak', 'שלום', 'end\\'];
  const f = await start(t, ['-e', 'let input="";process.stdin.on("data",data=>{input+=data;});process.stdin.on("end",()=>console.log(JSON.stringify({args:process.argv.slice(1),input})));', ...args]);
  await f.waitStarted(); f.guard.stdin.end('rpc\n');
  const [code] = await f.ended;
  assert.equal(code, 0, JSON.stringify({ messages: f.messages, output: f.output() })); assert.deepEqual(JSON.parse(f.output()), { args, input: 'rpc\n' });
  assert.ok(f.messages.some(m => m.cleanupConfirmed));
});

test('Windows runs an npm JS shim in a path containing spaces and shell characters without cmd.exe', native, async t => {
  const home = await mkdtemp(join(tmpdir(), 'minions % !& npm '));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, 'client.js'), 'console.log(JSON.stringify(process.argv.slice(2)));');
  const command = join(home, 'client.cmd');
  await writeFile(command, '@ECHO off\r\n"%_prog%" "%dp0%\\client.js" %*\r\n');
  const args = ['literal %PATH%', '"quoted"', 'trailing\\', 'שלום'];
  const f = await start(t, args, { command });
  await f.waitStarted(); assert.equal((await f.ended)[0], 0); assert.deepEqual(JSON.parse(f.output()), args);
  assert.ok(f.messages.some(m => m.cleanupConfirmed));
});

test('Windows refuses a first launch that expired while its helper was preparing', native, async t => {
  const f = await start(t, ['-e', 'console.log("must not execute")'], { launchByAt: Date.now() - 1 });
  assert.notEqual((await f.ended)[0], 0); assert.equal(f.messages.some(m => m.nativeStarted), false); assert.equal(f.output(), '');
});

test('Windows stops the owned tree at its fixed deadline backstop', native, async t => {
  const f = await start(t, ['-e', 'setInterval(()=>{},1000)'], { deadline: Date.now() + 3000 });
  const pid = await f.waitStarted();
  assert.equal(f.guard.extendDeadline, undefined);
  assert.equal(f.messages.filter(m => m.nativeStarted).length, 1);
  await f.ended; assert.equal(alive(pid), false);
  assert.ok(f.messages.some(m => m.guardStop === 'deadline')); assert.ok(f.messages.some(m => m.cleanupConfirmed));
});

for (const parentExits of [false, true]) test(`Windows contains detached descendants when ${parentExits ? 'the native parent exits' : 'Stop interrupts a turn'}`, native, async t => {
  const f = await start(t, ['-e', `const {spawn}=require('node:child_process'); const p=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}); console.log(p.pid); ${parentExits ? 'p.unref();' : 'setInterval(()=>{},1000);'}`]);
  await f.waitStarted(); const descendant = await until(() => Number(f.output().trim()), pid => pid > 0);
  if (!parentExits) f.guard.kill('SIGTERM');
  await f.ended; assert.equal(alive(descendant), false); assert.ok(f.messages.some(m => m.cleanupConfirmed));
});

test('Windows helper death kills only its job, including detached descendants, and retains an unrelated process', native, async t => {
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  t.after(() => unrelated.kill()); await once(unrelated, 'spawn');
  const f = await start(t, ['-e', `const {spawn}=require('node:child_process'); const p=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}); console.log(p.pid); setInterval(()=>{},1000);`]);
  const parent = await f.waitStarted(), descendant = await until(() => Number(f.output().trim()), pid => pid > 0);
  process.kill(f.guard.pid, 'SIGKILL'); await f.ended;
  await until(() => !alive(parent) && !alive(descendant), Boolean, 10000);
  assert.equal(alive(unrelated.pid), true); assert.equal(f.messages.some(m => m.cleanupConfirmed), false);
  // Kernel cleanup does not forge the guard receipt; exact-mission inspection is separate.
  assert.equal((await stopWindowsMission(f.mark)).cleanupConfirmed, true);
});

test('Windows controller death closes control IPC and the independent helper cleans up its native tree', native, async t => {
  const home = await mkdtemp(join(tmpdir(), 'minions Windows owner '));
  t.after(() => rm(home, { recursive: true, force: true }));
  const path = join(home, 'native.json'), mark = randomBytes(16).toString('hex');
  const script = `import {prepareSupervisedModel} from ${JSON.stringify(new URL('../src/model-guard.mjs', import.meta.url).href)}; const guard=prepareSupervisedModel({cwd:process.cwd(),env:{...process.env,MINIONS_MISSION_MARK:${JSON.stringify(mark)}},stdio:['ignore','pipe','pipe'],deadline:Date.now()+60000}); guard.stdout.resume();guard.stderr.resume();guard.on('message',m=>{if(m.nativeStarted)process.send({guard:guard.pid,native:m.nativeStarted});});guard.authorize(process.execPath,['-e',${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(path)},JSON.stringify({pid:process.pid}));setInterval(()=>{},1000);`)}]);`;
  const owner = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  owner.stderr.resume(); t.after(() => { if (owner.exitCode === null) owner.kill('SIGKILL'); });
  const [ids] = await once(owner, 'message');
  await until(async () => { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; } }, Boolean);
  owner.kill('SIGKILL'); await once(owner, 'close');
  await until(() => !alive(ids.native) && !alive(ids.guard), Boolean, 15000);
  assert.equal((await stopWindowsMission(mark)).cleanupConfirmed, true);
});
