import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { localBlobStore, mediaStore, retryWhileBusy } from '../src/blob-store.js';

describe('local media store', () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'blob-store-')); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('creates an object once, keeps the first bytes and leaves no pending files', async () => {
    const store = localBlobStore(join(root, 'media'));
    await store.createOnce('project/a-1', Buffer.from('first'), 'text/plain');
    await store.createOnce('project/a-1', Buffer.from('second'), 'text/plain');
    expect((await store.read('project/a-1')).toString()).toBe('first');
    expect(await readdir(join(root, 'media', 'project'))).toEqual(['a-1']);
  });

  it('settles parallel creates on a single stored object', async () => {
    const store = localBlobStore(root);
    await Promise.all(['x', 'y', 'z'].map(value => store.createOnce('same', Buffer.from(value), 'text/plain')));
    expect(['x', 'y', 'z']).toContain((await readFile(join(root, 'same'))).toString());
    expect(await readdir(root)).toEqual(['same']);
  });

  it('replaces and removes objects, ignoring a missing object on removal', async () => {
    const store = localBlobStore(root);
    await store.replace('m', Buffer.from('one'), 'application/octet-stream');
    await store.replace('m', Buffer.from('two'), 'application/octet-stream');
    expect((await store.read('m')).toString()).toBe('two');
    await store.remove('m');
    await store.remove('m');
    await expect(store.read('m')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps the original bytes when a replacement fails before it is published', async () => {
    const store = localBlobStore(root);
    await store.replace('m', Buffer.from('original'), 'application/octet-stream');
    // A value the file handle cannot write makes the staged write fail after the temporary file exists.
    await expect(store.replace('m', 42 as unknown as Buffer, 'application/octet-stream')).rejects.toThrow();
    expect((await store.read('m')).toString()).toBe('original');
    expect(await readdir(root)).toEqual(['m']);
  });

  it('lets parallel replacements of one key all succeed with one complete winner', async () => {
    const store = localBlobStore(root);
    const values = ['x'.repeat(4096), 'y'.repeat(4096), 'z'.repeat(4096)];
    await Promise.all(values.map(value => store.replace('same', Buffer.from(value), 'text/plain')));
    expect(values).toContain((await store.read('same')).toString());
    expect(await readdir(root)).toEqual(['same']);
  });

  // Simulated: FAT/exFAT drives and some shares have no hard links (macOS reports ENOTSUP; Windows codes vary).
  it('still creates once on a drive without hard links, keeping the first bytes and no pending files', async () => {
    const noLinks = async () => { throw Object.assign(new Error('operation not supported'), { code: 'ENOTSUP' }); };
    const store = localBlobStore(join(root, 'media'), noLinks);
    await store.createOnce('project/a-1', Buffer.from('first'), 'text/plain');
    await store.createOnce('project/a-1', Buffer.from('second'), 'text/plain');
    await Promise.all(['x', 'y', 'z'].map(value => store.createOnce('project/same', Buffer.from(value), 'text/plain')));
    expect((await store.read('project/a-1')).toString()).toBe('first');
    expect(['x', 'y', 'z']).toContain((await store.read('project/same')).toString());
    expect((await readdir(join(root, 'media', 'project'))).sort()).toEqual(['a-1', 'same']);
  });

  it('leaves no partial object when the fallback write fails', async () => {
    const noLinks = async () => { throw Object.assign(new Error('operation not supported'), { code: 'ENOTSUP' }); };
    const store = localBlobStore(root, noLinks);
    // A value the file handle cannot write fails after the exclusive target exists, like a full disk would.
    await expect(store.createOnce('m', 42 as unknown as Buffer, 'application/octet-stream')).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
    await store.createOnce('m', Buffer.from('retry'), 'application/octet-stream');
    expect((await store.read('m')).toString()).toBe('retry');
  });

  // Simulated: an injected busy error stands in for antivirus holding the file; native Windows acceptance is separate.
  it('retries a briefly busy file on Windows only, and gives up after a bounded number of attempts', async () => {
    const busyThen = (failures: number, code = 'EBUSY') => {
      let calls = 0;
      const operation = async () => {
        calls++;
        if (calls <= failures) throw Object.assign(new Error('resource busy or locked'), { code });
        return 'done';
      };
      return { operation, calls: () => calls };
    };
    const twice = busyThen(2, 'EPERM');
    await expect(retryWhileBusy(twice.operation, 'win32')).resolves.toBe('done');
    expect(twice.calls()).toBe(3);
    const elsewhere = busyThen(1);
    await expect(retryWhileBusy(elsewhere.operation, 'darwin')).rejects.toMatchObject({ code: 'EBUSY' });
    expect(elsewhere.calls()).toBe(1);
    const missing = busyThen(1, 'ENOENT');
    await expect(retryWhileBusy(missing.operation, 'win32')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(missing.calls()).toBe(1);
    const stuck = busyThen(Infinity);
    await expect(retryWhileBusy(stuck.operation, 'win32')).rejects.toMatchObject({ code: 'EBUSY' });
    expect(stuck.calls()).toBe(6);
  });

  it('refuses keys that could leave the root or collide with pending files', async () => {
    const store = localBlobStore(root);
    for (const key of ['', '../x', 'a/../../x', 'a//b', './x', 'a\\b', 'C:x', '.pending-1'])
      await expect(store.createOnce(key, Buffer.from('x'), 'text/plain')).rejects.toThrow('Invalid media object key.');
    expect(await readdir(root)).toEqual([]);
  });

  it('refuses names Windows would alias or reject on every platform, so a media folder can move between them', async () => {
    const store = localBlobStore(root);
    for (const key of ['NUL', 'project/con', 'project/aux.webp', 'COM1/x', 'lpt9.png', 'con .txt', 'NUL  .webp', 'x.', 'project/x ', 'a?b', 'a*b', 'a<b', 'a>b', 'a"b', 'a|b', 'a\u0001b'])
      await expect(store.createOnce(key, Buffer.from('x'), 'text/plain')).rejects.toThrow('Invalid media object key.');
    expect(await readdir(root)).toEqual([]);
    // Real keys are generated IDs with fingerprints; names that merely start with a device name stay valid.
    for (const key of ['0123abcd/u1-f00d', 'u2-f00d-webp-v1', 'nullable', 'console.log', 'com10'])
      await store.createOnce(key, Buffer.from('ok'), 'text/plain');
    expect((await store.read('u2-f00d-webp-v1')).toString()).toBe('ok');
  });
});

describe('media directory', () => {
  it('requires an absolute MINIONS_BLOB_DIR and stores each kind in its own subdirectory', async () => {
    for (const env of [{}, { MINIONS_BLOB_DIR: 'relative/media' }, { MINIONS_BLOB_DIR: '' }, { MINIONS_BLOB_DIR: '  ' }])
      expect(() => mediaStore('chat-media', env)).toThrow('absolute');
    const root = await mkdtemp(join(tmpdir(), 'media-dir-'));
    try {
      await mediaStore('chat-media', { MINIONS_BLOB_DIR: root }).replace('a', Buffer.from('x'), 'text/plain');
      expect((await readFile(join(root, 'chat-media', 'a'))).toString()).toBe('x');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
