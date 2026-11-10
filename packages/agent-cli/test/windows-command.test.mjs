import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveWindowsCommand, windowsPowerShell, hostToolEnvironment, windowsHelperEnvironment } from '../src/windows-command.mjs';

test('OS tool probes retain native environment discovery and exclude credentials', () => {
  assert.deepEqual(hostToolEnvironment({ Path: 'tools', systemroot: 'C:\\Windows', Temp: 'private', GH_TOKEN: 'secret', OPENAI_API_KEY: 'secret', ANTHROPIC_API_KEY: 'secret', UNRELATED_SECRET: 'secret' }), { PATH: 'tools', SystemRoot: 'C:\\Windows', TEMP: 'private' });
});

test('Windows helpers pin built-in module discovery and probes exclude credentials', { skip: process.platform !== 'win32' }, () => {
  const env = windowsHelperEnvironment({ ...hostToolEnvironment(process.env), PSMODULEPATH: 'untrusted-module-path', GH_TOKEN: undefined });
  assert.equal(env.PSModulePath, windowsPowerShell(process.env).replace(/powershell\.exe$/i, 'Modules'));
  assert.equal(env.PSMODULEPATH, undefined);
  assert.equal(env.GH_TOKEN, undefined);
});

test('Windows native and npm clients preserve arguments without a shell and use case-insensitive PATH', () => {
  const files = new Set(['C:\\Coding tools\\claude.exe', 'C:\\Coding tools\\codex.cmd', 'C:\\Coding tools\\node_modules\\@openai\\codex\\bin\\codex.js']);
  const options = { cwd: 'C:\\project with spaces', env: { Path: '"C:\\Coding tools"' }, node: 'C:\\Node\\node.exe', isFile: path => files.has(path),
    read: () => '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n' };
  const args = ['space here', '"quotes"', '%USERNAME%', '$env:HOME', '`command`', '&|<>', 'line\nbreak', 'שלום', 'end\\'];
  assert.deepEqual(resolveWindowsCommand('claude', args, options), { command: 'C:\\Coding tools\\claude.exe', args });
  assert.deepEqual(resolveWindowsCommand('codex', args, options), { command: options.node, args: ['C:\\Coding tools\\node_modules\\@openai\\codex\\bin\\codex.js', ...args] });
});

test('Windows rejects arbitrary scripts, missing clients and shims escaping their installation', () => {
  const options = { cwd: 'C:\\project', env: { PATH: 'C:\\tools' }, isFile: () => true, read: () => '"%_prog%" "%dp0%\\..\\outside.js" %*' };
  for (const command of ['custom.bat', 'custom.ps1', 'custom.cmd']) assert.throws(() => resolveWindowsCommand(command, [], options), /require a native/);
  assert.throws(() => resolveWindowsCommand('client', [], { ...options, isFile: () => false }), /not found/);
  assert.throws(() => resolveWindowsCommand('client.exe', ['\0'], options), /Invalid/);
});

test('Windows supervision only uses the absolute built-in PowerShell and fails clearly without it', () => {
  assert.equal(windowsPowerShell({ systemroot: 'C:\\Windows' }, () => true), 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.throws(() => windowsPowerShell({ SystemRoot: 'relative' }, () => true), /absolute SystemRoot/);
  assert.throws(() => windowsPowerShell({ SystemRoot: 'C:\\Windows' }, () => false), /requires the built-in/);
});
