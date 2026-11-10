import path from 'node:path';
import { expect, test } from 'vitest';
import { selfHostedPaths } from '../src/self-hosted-paths.js';

test('standalone storage requires explicit persistent paths without falling back to memory or cloud', () => {
  const env = { MLSWARM_SQLITE_PATH: '/private/engine data/mlswarm.sqlite', MLSWARM_BLOB_DIR: '/private/engine data/blobs' };
  expect(selfHostedPaths(env, path.posix)).toEqual({ sqlitePath: env.MLSWARM_SQLITE_PATH, blobRoot: env.MLSWARM_BLOB_DIR });
  for (const key of ['MLSWARM_SQLITE_PATH', 'MLSWARM_BLOB_DIR'] as const) {
    for (const value of [undefined, '', ':memory:', 'relative/engine', 'file:///engine.sqlite', '/private/bad\0path']) {
      expect(() => selfHostedPaths({ ...env, [key]: value }, path.posix)).toThrow(key);
    }
  }
});

test('Windows storage accepts drive paths with spaces and refuses drive-relative, root-relative and UNC locations', () => {
  const env = { MLSWARM_SQLITE_PATH: 'C:\\Users\\Ana Lee\\engine data\\mlswarm.sqlite', MLSWARM_BLOB_DIR: 'D:\\engine data\\blobs' };
  expect(selfHostedPaths(env, path.win32)).toEqual({ sqlitePath: env.MLSWARM_SQLITE_PATH, blobRoot: env.MLSWARM_BLOB_DIR });
  for (const key of ['MLSWARM_SQLITE_PATH', 'MLSWARM_BLOB_DIR'] as const) {
    for (const value of ['C:engine.sqlite', '\\engine.sqlite', '/engine.sqlite', '\\\\server\\share\\engine.sqlite']) {
      expect(() => selfHostedPaths({ ...env, [key]: value }, path.win32)).toThrow(key);
    }
  }
});

test('Windows storage refuses names Windows would alias: device names, streams, reserved characters and trailing dots or spaces', () => {
  const env = { MLSWARM_SQLITE_PATH: 'C:\\Users\\Ana Lee\\engine data\\mlswarm.sqlite', MLSWARM_BLOB_DIR: 'D:\\engine data\\blobs\\' };
  // Forward slashes, a trailing separator, .. and names that merely contain a device name stay valid.
  for (const value of ['C:/Users/Ana Lee/mlswarm.sqlite', 'C:\\data\\..\\data\\mlswarm.sqlite', 'C:\\console\\nullable.sqlite', 'C:\\com10\\aux-data\\db.sqlite']) {
    expect(selfHostedPaths({ ...env, MLSWARM_SQLITE_PATH: value }, path.win32).sqlitePath).toBe(value);
  }
  expect(selfHostedPaths(env, path.win32).blobRoot).toBe(env.MLSWARM_BLOB_DIR);
  for (const key of ['MLSWARM_SQLITE_PATH', 'MLSWARM_BLOB_DIR'] as const) {
    for (const value of ['C:\\data\\NUL', 'C:\\data\\nul.sqlite', 'C:\\CON\\mlswarm.sqlite', 'C:\\data\\com1.sqlite', 'C:\\data\\con .sqlite', 'C:\\data\\LPT9', 'C:\\data\\CONOUT$',
      'C:\\data\\mlswarm.sqlite:hidden', 'C:\\data\\mlswarm.sqlite.', 'C:\\engine data \\mlswarm.sqlite', 'C:\\data\\what?.sqlite', 'C:\\data\\a|b', 'C:\\data\\"q"']) {
      expect(() => selfHostedPaths({ ...env, [key]: value }, path.win32)).toThrow(key);
    }
  }
});

test('POSIX storage keeps names Windows would refuse; only Windows paths are checked for them', () => {
  for (const value of ['/srv/engine data/nul.sqlite', '/srv/data./mlswarm.sqlite', '/srv/a:b/mlswarm.sqlite']) {
    expect(selfHostedPaths({ MLSWARM_SQLITE_PATH: value, MLSWARM_BLOB_DIR: '/srv/blobs' }, path.posix).sqlitePath).toBe(value);
  }
});
