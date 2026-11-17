// Private media objects in the engine's local media directory (MINIONS_BLOB_DIR). Callers keep
// their own keys, limits and integrity checks; objects are never exposed through a public URL.
import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { windowsSafeName } from './self-hosted-paths.js';

export type BlobStore = {
  /** Rejects with code ENOENT when the object is missing. */
  read(key: string): Promise<Buffer>;
  /** Creates the object once; an existing object is kept, so callers verify its bytes. */
  createOnce(key: string, bytes: Buffer, contentType: string): Promise<void>;
  /** Writes or replaces the object. */
  replace(key: string, bytes: Buffer, contentType: string): Promise<void>;
  /** Removes the object; a missing object is not an error. */
  remove(key: string): Promise<void>;
};

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

async function syncDirectory(root: string) {
  // Windows cannot open or fsync a directory (EPERM/EISDIR); the file itself is already synced.
  if (process.platform === 'win32') return;
  const directory = await open(root, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

// Windows refuses to replace or delete a file another process briefly holds open (antivirus, indexer, a reader).
const busy = (error: unknown) => ['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '');

/** Retries a rename or unlink a few times, with backoff, while Windows reports the file busy; other errors and platforms fail at once. */
export async function retryWhileBusy<T>(operation: () => Promise<T>, platform: NodeJS.Platform = process.platform): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (platform !== 'win32' || !busy(error) || attempt >= 5) throw error;
      await new Promise(done => setTimeout(done, 20 * 2 ** attempt));
    }
  }
}

// rename replaces atomically: POSIX rename(2), MoveFileEx(MOVEFILE_REPLACE_EXISTING) on Windows.
const publish = (temporary: string, target: string) => retryWhileBusy(() => rename(temporary, target));

// Best-effort cleanup of a file this store created; one still held open after the retries is left behind.
const discard = (file: string) => retryWhileBusy(() => unlink(file)).catch(() => undefined);

async function writeSynced(path: string, bytes: Buffer) {
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

/**
 * Fallback publish for drives without hard links (FAT, exFAT, some network shares): create the name exclusively, so
 * the first object is still kept. A reader racing this write can see it partly written, so callers verify bytes; a
 * failed write removes the file it created rather than leaving a partial object under the name. A concurrent call
 * that finds the name already taken returns at once, so if this first write then fails, that caller was told an
 * object exists that is gone; it learns so on read (ENOENT). These drives offer no atomic create-with-content.
 */
async function createExclusive(target: string, bytes: Buffer) {
  let handle;
  try { handle = await open(target, 'wx', 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return; throw error; }
  try { await handle.writeFile(bytes); await handle.sync(); }
  catch (error) { await handle.close(); handle = undefined; await discard(target); throw error; }
  finally { await handle?.close(); }
}

/**
 * Keys are `/`-separated segments under `root`; no segment may be empty, a dot name or a pending file. Every
 * platform also refuses names Windows would alias or reject, so a media folder stays valid when moved there.
 */
export function localBlobStore(root: string, linkFile: (existing: string, created: string) => Promise<void> = link): BlobStore {
  const path = (key: string) => {
    const segments = key.split('/');
    if (segments.some(part => !windowsSafeName(part) || part.startsWith('.pending-')))
      throw new Error('Invalid media object key.');
    return join(root, ...segments);
  };
  return {
    read: key => readFile(path(key)),
    async createOnce(key, bytes) {
      const target = path(key);
      const directory = dirname(target);
      await mkdir(directory, { recursive: true });
      const temporary = join(directory, `.pending-${randomUUID()}`);
      try {
        await writeSynced(temporary, bytes);
        // A hard link publishes the synced file atomically and refuses an existing name on Windows and macOS.
        try { await linkFile(temporary, target); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') await createExclusive(target, bytes); }
        await syncDirectory(directory);
      } finally { await discard(temporary); }
    },
    async replace(key, bytes) {
      // The existing object stays intact until the synced replacement takes its name.
      const target = path(key);
      const directory = dirname(target);
      await mkdir(directory, { recursive: true });
      const temporary = join(directory, `.pending-${randomUUID()}`);
      try {
        await writeSynced(temporary, bytes);
        await publish(temporary, target);
        await syncDirectory(directory);
      } finally { await discard(temporary); }
    },
    async remove(key) { await retryWhileBusy(() => unlink(path(key))).catch(error => { if (!missing(error)) throw error; }); },
  };
}

/** The media store for one kind of object: a subdirectory of the absolute MINIONS_BLOB_DIR (npm run setup sets it). */
export function mediaStore(kind: string, env: NodeJS.ProcessEnv = process.env): BlobStore {
  const root = env.MINIONS_BLOB_DIR;
  if (!root?.trim() || !isAbsolute(root)) throw new Error('MINIONS_BLOB_DIR must be an absolute directory.');
  return localBlobStore(join(root, kind));
}
