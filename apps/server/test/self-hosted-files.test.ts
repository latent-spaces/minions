import { chmodSync, linkSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { canonicalPath, createOwnerFile, insideUserFolder, readOwnerFile } from '../src/self-hosted-files.js';

let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'self-hosted-owner-')); chmodSync(directory, 0o700); });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

test('private owner files round-trip without replacing an existing credential', () => {
  const file = join(directory, 'owner.json');
  createOwnerFile(file, '{"synthetic":true}\n');
  expect(readOwnerFile(file)).toBe('{"synthetic":true}\n');
  expect(() => createOwnerFile(file, 'replacement')).toThrow();
  expect(readFileSync(file, 'utf8')).toBe('{"synthetic":true}\n');
});

test('credential aliases and oversized inputs are refused', () => {
  const file = join(directory, 'owner.json'), linked = join(directory, 'linked.json');
  createOwnerFile(file, 'synthetic');
  linkSync(file, linked);
  expect(() => readOwnerFile(file)).toThrow('regular file');
  expect(() => readOwnerFile(linked)).toThrow('regular file');
  expect(() => createOwnerFile(join(directory, 'large'), 'x'.repeat(16_385))).toThrow('size limit');
});

test.skipIf(process.platform === 'win32')('POSIX credential permissions and symlinks remain strict', () => {
  const file = join(directory, 'owner.json'), linked = join(directory, 'symlink.json');
  createOwnerFile(file, 'synthetic');
  symlinkSync(file, linked);
  expect(() => readOwnerFile(linked)).toThrow('symbolic links');
  chmodSync(file, 0o644);
  expect(() => readOwnerFile(file)).toThrow('private');
  chmodSync(file, 0o600);
  chmodSync(directory, 0o755);
  expect(() => readOwnerFile(file)).toThrow('private');
});

test.skipIf(process.platform === 'win32')('a subprocess without ownership APIs refuses private owner storage', () => {
  const file = join(directory, 'owner.json');
  createOwnerFile(file, 'synthetic');
  const source = new URL('../src/self-hosted-files.ts', import.meta.url).href;
  const script = `process.getuid = undefined;
    const { readOwnerFile } = await import(${JSON.stringify(source)});
    try { readOwnerFile(${JSON.stringify(file)}); process.exitCode = 2; }
    catch (error) { if (!error.message.includes('ownership check')) throw error; }`;
  expect(() => execFileSync(process.execPath, ['--input-type=module', '-e', script], { stdio: 'pipe' })).not.toThrow();
});

// Windows rules, checked with path.win32 on any host. Native Windows acceptance is still separate.
test('Windows owner storage must be strictly inside the user folder: drives, case, spaces, siblings and shares', () => {
  const home = 'C:\\Users\\Ana Lee';
  for (const target of ['C:\\Users\\Ana Lee\\.minions\\engine', 'c:\\users\\ana lee\\engine data\\private', 'C:\\Users\\Ana Lee\\a\\..\\b']) {
    expect(insideUserFolder(home, target, path.win32), target).toBe(true);
  }
  for (const target of ['C:\\Users\\Ana Lee', 'C:\\Users\\Ana Lee\\', 'C:\\Users\\Ana Lee2\\engine', 'C:\\Users\\Ana Lee\\..\\Bob',
    'C:\\Users', 'D:\\Users\\Ana Lee\\engine', '\\\\server\\share\\Ana Lee\\engine', 'C:\\ProgramData\\minions']) {
    expect(insideUserFolder(home, target, path.win32), target).toBe(false);
  }
});

test('the same containment rule holds for POSIX paths', () => {
  expect(insideUserFolder('/home/ana lee', '/home/ana lee/.minions/engine', path.posix)).toBe(true);
  for (const target of ['/home/ana lee', '/home/ana lee2/engine', '/home/ana lee/../bob', '/srv/engine']) {
    expect(insideUserFolder('/home/ana lee', target, path.posix), target).toBe(false);
  }
});

// A subprocess that reports win32 takes the Windows branch: a private directory outside the user folder, which the
// POSIX branch accepts, is refused, and the refusal names the Windows rule. POSIX checks are untouched by this.
test.skipIf(process.platform === 'win32')('a simulated Windows process confines owner files to the user folder', () => {
  const file = join(directory, 'owner.json');
  createOwnerFile(file, 'synthetic');
  expect(readOwnerFile(file)).toBe('synthetic');
  const source = new URL('../src/self-hosted-files.ts', import.meta.url).href;
  const script = `Object.defineProperty(process, 'platform', { value: 'win32' });
    const { readOwnerFile, createOwnerFile } = await import(${JSON.stringify(source)});
    for (const run of [() => readOwnerFile(${JSON.stringify(file)}), () => createOwnerFile(${JSON.stringify(join(directory, 'new.json'))}, 'x')]) {
      try { run(); process.exitCode = 2; } catch (error) { if (!error.message.includes('inside a private subdirectory of your user folder')) throw error; }
    }`;
  expect(() => execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { stdio: 'pipe' })).not.toThrow();
  expect(() => readFileSync(join(directory, 'new.json'))).toThrow();
});

// Simulated: on Windows the user-folder rule compares native canonical paths, so an 8.3 short-name or other-case
// spelling of a folder inside the user folder still counts as inside. Native Windows still has to confirm the call.
test('Windows compares canonical paths, so a short-name spelling of the user folder stays inside it', () => {
  const home = 'C:\\Users\\Ana Lee', short = 'C:\\Users\\ANALEE~1\\AppData\\Local\\Temp\\minions';
  const native = (target: string) => target.replace(/^c:\\users\\analee~1/i, home);
  const spelling = (target: string) => target;
  expect(insideUserFolder(canonicalPath(home, native), canonicalPath(short, native), path.win32)).toBe(true);
  expect(insideUserFolder(canonicalPath(home, spelling), canonicalPath(short, spelling), path.win32)).toBe(false);
  // A volume where the native call fails keeps the previous behaviour instead of refusing every owner file.
  const unavailable = () => { throw Object.assign(new Error('unsupported'), { code: 'EISDIR' }); };
  expect(canonicalPath(short, unavailable, spelling)).toBe(short);
  // On this host, the native and JS calls agree on a real folder.
  expect(canonicalPath(directory)).toBe(realpathSync(directory));
});

// Simulated: the Windows branch of the owner-file check itself uses the native canonical path. The subprocess's native
// realpath reports this folder as inside the user folder (as an expanded short name would be); the JS realpath doesn't.
test.skipIf(process.platform === 'win32')('a simulated Windows process accepts a folder whose native canonical path is inside the user folder', () => {
  const source = new URL('../src/self-hosted-files.ts', import.meta.url).href;
  const file = join(directory, 'owner.json');
  const script = `import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const real = fs.realpathSync.native, folder = fs.realpathSync(${JSON.stringify(directory)});
    fs.realpathSync.native = target => fs.realpathSync(target) === folder ? path.join(real(os.userInfo().homedir), 'AppData', 'minions') : real(target);
    const { createOwnerFile, readOwnerFile } = await import(${JSON.stringify(source)});
    createOwnerFile(${JSON.stringify(file)}, 'synthetic');
    if (readOwnerFile(${JSON.stringify(file)}) !== 'synthetic') process.exitCode = 2;`;
  expect(() => execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { stdio: 'pipe' })).not.toThrow();
  expect(readFileSync(file, 'utf8')).toBe('synthetic');
});
