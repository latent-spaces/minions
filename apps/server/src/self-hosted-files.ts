// Signing secrets and owner sign-in links stay in private operator files, never console output.
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync, type Stats } from 'node:fs';
import path, { dirname, isAbsolute } from 'node:path';
import { userInfo } from 'node:os';

function privateStat(stat: Stats): void {
  if (process.platform === 'win32') return;
  if (typeof process.getuid !== 'function') throw new Error('Private owner files require an available operating-system ownership check.');
  if (stat.uid !== process.getuid() || stat.mode & 0o077) throw new Error('Owner files and their directory must belong to you and be private to your account.');
}

/**
 * Whether target is strictly inside home (not home itself, a sibling or another drive or share). Paths are compared
 * with the given path module, so Windows rules (case-insensitive drives, backslashes, UNC) can be tested anywhere.
 */
export function insideUserFolder(home: string, target: string, paths: Pick<typeof path, 'relative' | 'isAbsolute' | 'sep'> = path): boolean {
  const inside = paths.relative(home, target);
  return inside !== '' && inside !== '..' && !inside.startsWith(`..${paths.sep}`) && !paths.isAbsolute(inside);
}

/**
 * Windows canonical form for the user-folder rule. The native call (GetFinalPathNameByHandle) expands 8.3 short names
 * such as ANALEE~1, which %TEMP% often contains, and fixes letter case; Node's JS realpath keeps the given spelling, so
 * a folder inside the user folder could compare outside it. Volumes where the native call fails keep the JS result.
 */
export function canonicalPath(target: string, native: (target: string) => string = realpathSync.native, fallback: (target: string) => string = realpathSync): string {
  try { return native(target); } catch { return fallback(target); }
}

function privateDirectory(directory: string, create = false): void {
  if (!isAbsolute(directory)) throw new Error('Choose an absolute private owner-file path.');
  if (create) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Owner files require a private regular directory.');
  privateStat(stat);
  // As in connector private state, Windows storage is confined to the account's user folder.
  // POSIX mode bits cannot establish Windows ACLs; do not pretend that chmod checks them.
  if (process.platform === 'win32') {
    if (!insideUserFolder(canonicalPath(userInfo().homedir), canonicalPath(directory))) {
      throw new Error('On Windows, owner files must be inside a private subdirectory of your user folder.');
    }
  }
}

function regularFile(stat: Stats): void {
  privateStat(stat);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16_384) throw new Error('Owner storage must be one small private regular file.');
}

/** Never follows a named symlink or accepts a hard-linked credential. */
export function readOwnerFile(file: string): string {
  privateDirectory(dirname(file));
  const named = lstatSync(file);
  if (named.isSymbolicLink()) throw new Error('Owner files cannot be symbolic links.');
  regularFile(named);
  const descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(descriptor);
    regularFile(opened);
    if (opened.dev !== named.dev || opened.ino !== named.ino) throw new Error('Owner storage changed while opening it.');
    return readFileSync(descriptor, 'utf8');
  } finally { closeSync(descriptor); }
}

/** Explicit initialization/session actions create a new file and never replace existing credentials. */
export function createOwnerFile(file: string, value: string): void {
  if (Buffer.byteLength(value) > 16_384) throw new Error('Owner storage exceeds its size limit.');
  privateDirectory(dirname(file), true);
  const descriptor = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { writeFileSync(descriptor, value); fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
}

/** A persistent SQLite database can grow beyond the small credential-file limit. */
export function assertPrivateDataFile(file: string): void {
  privateDirectory(dirname(file));
  const stat = lstatSync(file);
  privateStat(stat);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('The database must be one private regular file, without links.');
}
