import { constants, lstatSync, realpathSync, fstatSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join, dirname, basename, resolve, relative, isAbsolute, sep } from 'node:path';
import { userInfo } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';

// Windows has no permission bits: every file reports mode 666 and the folder's access list decides who
// reads it. Private storage there must be inside the person's own user folder, which Windows keeps to
// that account, the system and administrators. The other checks are the same on every system.
const windows = process.platform === 'win32';
const exposed = stat => !windows && (stat.mode & 0o077);
// The native call also expands Windows short names (RUNNER~1), so one folder has one spelling.
export const physicalPath = windows ? realpathSync.native : realpathSync;

export function canonicalPath(value) {
  let path = resolve(value);
  const tail = [];
  while (!lstatExists(path)) { tail.unshift(basename(path)); path = dirname(path); }
  return join(physicalPath(path), ...tail);
}
// True when path is root or below it. Windows separates with a backslash and ignores letter case.
export function pathInside(root, path) {
  const part = relative(root, path);
  return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part));
}
// Physical paths matter: a symlink spelling must not allow credentials inside a checkout.
export function assertStateOutsideWorkspace(home, folder) {
  const state = canonicalPath(home), workspace = canonicalPath(folder);
  if (pathInside(workspace, state) || pathInside(state, workspace)) throw new Error('Private connection state and the project workspace must be separate sibling paths. Choose storage outside the checkout.');
}
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function privateDir(path) {
  try { mkdirSync(path, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || exposed(stat)) throw new Error('Connection storage must be a private directory, without symbolic links.');
}
export function ensureHome(home) {
  // Only the caller-selected root is created recursively. Existing root must be private.
  mkdirSync(home, { recursive: true, mode: 0o700 });
  privateDir(home);
  if (windows) {
    const profile = canonicalPath(userInfo().homedir), state = canonicalPath(home);
    if (state === profile || !pathInside(profile, state)) throw new Error(`Private connection storage on Windows must be inside your user folder (${profile}), which Windows keeps private to your account.`);
  }
}
export function readPrivate(path, json = false) {
  // Windows cannot refuse a symbolic link while opening, so it is refused by name first.
  if (windows && lstatSync(path).isSymbolicLink()) throw new Error('Connection files must be private regular files.');
  for (let attempt = 0; attempt < 3; attempt++) {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || exposed(stat) || stat.nlink > 1) throw new Error('Connection files must be private regular files.');
      // Atomic replacement can unlink the inode between open and fstat. Reopen
      // the named record; never read an unlinked inode or relax private-file checks.
      if (stat.nlink === 0 && attempt < 2) continue;
      if (stat.nlink !== 1) throw new Error('Connection files must be private regular files.');
      const value = readFileSync(fd, 'utf8');
      if (!json) return value;
      try { return JSON.parse(value); } catch { throw new Error('Invalid private connection record. Restore its backup or reconnect.'); }
    } finally { closeSync(fd); }
  }
}
export function writePrivate(path, value) {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || exposed(stat) || stat.nlink !== 1) throw new Error('Refusing to replace unsafe connection storage.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`); }
  finally { closeSync(fd); }
  try { replaceFile(temp, path); } finally { try { unlinkSync(temp); } catch {} }
}
// Windows refuses to replace a file while another process, often a virus scanner, holds it open. Wait briefly.
export function replaceFile(temp, path) {
  for (let attempt = 0; ; attempt++) {
    try { return renameSync(temp, path); }
    catch (error) {
      if (!windows || attempt === 9 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
    }
  }
}
export function connectionDir(home, id) {
  if (!/^[a-f0-9]{64}\/[\w-]{1,200}$/.test(id ?? '')) throw new Error('Choose a connection ID from status.');
  ensureHome(home);
  const [project, agent] = id.split('/');
  privateDir(join(home, project));
  const dir = join(home, project, agent);
  privateDir(dir);
  return dir;
}
export function save(dir, record) { writePrivate(join(dir, 'connection.json'), record); }
export function lstatExists(path) { try { lstatSync(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
