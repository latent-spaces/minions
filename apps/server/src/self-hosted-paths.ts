import path from 'node:path';

// Windows reserves these device names in every folder, with or without an extension: NUL.sqlite and `con .txt` are devices.
const WINDOWS_DEVICE = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³]) *(\.|$)/i;

/**
 * Whether Windows stores one path segment under exactly this name: not a device name, no character it refuses
 * (including the `:` that selects an alternate data stream), and no trailing dot or space, which it silently drops.
 */
export function windowsSafeName(segment: string): boolean {
  return segment !== '' && !WINDOWS_DEVICE.test(segment) && !/[<>:"/\\|?*\x00-\x1f]/.test(segment) && !/[. ]$/.test(segment);
}

/** Explicit persistent locations only: a missing path must never select an in-memory store. */
export function absoluteSelfHostedPath(key: string, value: string | undefined, paths: Pick<typeof path, 'isAbsolute'> = path): string {
  if (!value || /[\x00-\x1f\x7f]/.test(value) || !paths.isAbsolute(value)) {
    throw new Error(`${key} must be an absolute filesystem path for the standalone engine.`);
  }
  // On Windows, a leading slash without a drive is relative to the process's current drive.
  // SQLite WAL is for a local filesystem, so UNC shares are not a supported database location.
  if (paths === path.win32 || paths === path && process.platform === 'win32') {
    if (!/^[a-z]:[\\/]/i.test(value)) throw new Error(`${key} must include a local Windows drive and an absolute path.`);
    // The database's -wal, -shm and .lock files are named after it, so each folder and file name must be stored as written.
    if (!value.slice(3).split(/[\\/]/).every(part => part === '' || part === '.' || part === '..' || windowsSafeName(part))) {
      throw new Error(`${key} must not use a Windows device name, a stream (:), a reserved character or a name ending in a dot or space.`);
    }
  }
  return value;
}

/**
 * Whether two configured paths name the same location: compared resolved, and case-insensitively on Windows and on
 * macOS, whose default volumes ignore case. A rare case-sensitive volume is refused conservatively, never aliased.
 */
export function samePath(a: string, b: string, paths: Pick<typeof path, 'resolve'> = path): boolean {
  const foldCase = paths === path.win32 || paths === path && ['win32', 'darwin'].includes(process.platform);
  const key = (value: string) => foldCase ? paths.resolve(value).toLowerCase() : paths.resolve(value);
  return key(a) === key(b);
}

export function selfHostedPaths(env: NodeJS.ProcessEnv = process.env, paths: Pick<typeof path, 'isAbsolute'> = path) {
  return { sqlitePath: absoluteSelfHostedPath('MINIONS_SQLITE_PATH', env.MINIONS_SQLITE_PATH, paths),
    blobRoot: absoluteSelfHostedPath('MINIONS_BLOB_DIR', env.MINIONS_BLOB_DIR, paths) };
}
