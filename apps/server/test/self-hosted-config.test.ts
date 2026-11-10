import { expect, test } from 'vitest';
import path from 'node:path';
import { selfHostedConfig } from '../src/self-hosted-config.js';
const env = { MLSWARM_ENGINE: 'self-hosted', MLSWARM_SQLITE_PATH: path.resolve('private/db.sqlite'),
  MLSWARM_BLOB_DIR: path.resolve('private/media'), MLSWARM_OWNER_FILE: path.resolve('private/owner.json') };

test('explicit loopback configuration supports an ephemeral test port', () => {
  expect(selfHostedConfig({ ...env, PORT: '0' })).toMatchObject({ port: 0, host: '127.0.0.1' });
});
test('ambiguous settings fail before database initialization', () => {
  for (const patch of [{ MLSWARM_ENGINE: '' }, { MLSWARM_ENGINE: 'hosted' },
    { HOST: '0.0.0.0' }, { PORT: '-1' }, { PORT: '65536' }, { TRUST_PROXY: 'true' },
    { MLSWARM_OWNER_FILE: undefined }, { MLSWARM_OWNER_FILE: 'relative' }, { MLSWARM_BLOB_DIR: 'relative' }, { MLSWARM_SQLITE_PATH: 'relative.sqlite' }]) {
    expect(() => selfHostedConfig({ ...env, ...patch })).toThrow();
  }
});
test('the database, media folder and owner file must be different locations, however Windows spells them', () => {
  const windows = { ...env, MLSWARM_SQLITE_PATH: 'C:\\Users\\Ana Lee\\engine\\db.sqlite', MLSWARM_BLOB_DIR: 'C:\\Users\\Ana Lee\\engine\\media',
    MLSWARM_OWNER_FILE: 'C:\\Users\\Ana Lee\\engine\\owner.json' };
  expect(selfHostedConfig(windows, path.win32).ownerFile).toBe(windows.MLSWARM_OWNER_FILE);
  for (const patch of [{ MLSWARM_OWNER_FILE: 'c:\\users\\ana lee\\ENGINE\\DB.SQLITE' }, { MLSWARM_OWNER_FILE: 'C:/Users/Ana Lee/engine/db.sqlite' },
    { MLSWARM_BLOB_DIR: 'C:\\Users\\Ana Lee\\engine\\media\\..\\db.sqlite' }, { MLSWARM_OWNER_FILE: 'C:\\Users\\Ana Lee\\engine\\MEDIA\\' }]) {
    expect(() => selfHostedConfig({ ...windows, ...patch }, path.win32)).toThrow(/separate|own private file/);
  }
  // On any host, a dot segment still names the same file.
  expect(() => selfHostedConfig({ ...env, MLSWARM_OWNER_FILE: path.posix.join(path.posix.dirname(env.MLSWARM_SQLITE_PATH), '.', 'db.sqlite') }, path.posix)).toThrow('own private file');
});
