import { statSync, readFileSync } from 'node:fs';
import { win32 } from 'node:path';

const environmentValue = (env, name) => Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];

// OS discovery/compilation and local Git metadata never need provider or GitHub
// credentials. Normalize key spelling for Windows subprocesses.
export function hostToolEnvironment(env = process.env) {
  return Object.fromEntries(['PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'SystemDrive', 'COMSPEC', 'OS', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData', 'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE', 'USERNAME', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'HOME'].flatMap(name => {
    const value = environmentValue(env, name); return typeof value === 'string' ? [[name, value]] : [];
  }));
}

export function windowsHelperEnvironment(env = process.env) {
  const executable = windowsPowerShell(env);
  // Never inherit a coding client's/user's module search paths. Pin the built-in
  // utility module instead of making a stripped host rediscover default paths.
  return { ...Object.fromEntries(Object.entries(env).filter(([key]) => key.toLowerCase() !== 'psmodulepath')), PSModulePath: win32.join(win32.dirname(executable), 'Modules') };
}

// Never pass model text through cmd.exe/PowerShell. npm's generated .cmd shim
// has one known JS entry point; run that entry point with this service's Node.
// Arbitrary batch/PowerShell scripts are not an executable-provider contract.
export function resolveWindowsCommand(command, args = [], {
  env = process.env, cwd = process.cwd(), node = process.execPath,
  isFile = path => { try { return statSync(path).isFile(); } catch { return false; } },
  read = path => { if (statSync(path).size > 32768) throw new Error('Provider shim is too large.'); return readFileSync(path, 'utf8'); },
} = {}) {
  if (typeof command !== 'string' || !command || command.includes('\0') || !args.every(arg => typeof arg === 'string' && !arg.includes('\0'))) throw new Error('Invalid Windows provider command.');
  const roots = /[\\/]/.test(command) ? [''] : String(environmentValue(env, 'PATH') ?? '').split(';').filter(Boolean).map(value => value.replace(/^"(.*)"$/, '$1'));
  const extensions = win32.extname(command) ? [''] : ['.exe', '.cmd'];
  let file;
  for (const root of roots) {
    for (const extension of extensions) {
      const candidate = win32.resolve(cwd, root, command + extension);
      if (isFile(candidate)) { file = candidate; break; }
    }
    if (file) break;
  }
  if (!file) throw new Error('The Windows coding client executable was not found on PATH.');
  const extension = win32.extname(file).toLowerCase();
  if (extension === '.exe') return { command: file, args };
  if (extension === '.cmd') {
    const matches = [...read(file).matchAll(/"%_prog%"[ \t]+"%dp0%[\\/]([^"\r\n]+\.(?:c|m)?js)"[ \t]+%\*/g)];
    if (matches.length === 1) {
      const root = win32.dirname(file), entry = win32.resolve(root, matches[0][1]);
      const relative = win32.relative(root, entry);
      if (relative && relative !== '..' && !relative.startsWith('..\\') && !win32.isAbsolute(relative) && isFile(entry)) return { command: node, args: [entry, ...args] };
    }
  }
  throw new Error('Windows workers require a native .exe or a standard npm .cmd shim with a JavaScript entry point. No shell was started.');
}

export function windowsPowerShell(env = process.env, exists = path => { try { return statSync(path).isFile(); } catch { return false; } }) {
  const root = environmentValue(env, 'SystemRoot');
  if (typeof root !== 'string' || !win32.isAbsolute(root)) throw new Error('Windows worker supervision requires an absolute SystemRoot.');
  const command = win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (!exists(command)) throw new Error('Windows worker supervision requires the built-in Windows PowerShell.');
  return command;
}
