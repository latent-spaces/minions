import { expect, test } from 'vitest';
import path from 'node:path';
import { selfHostedConfig } from '../src/self-hosted-config.js';
const env = { MINIONS_ENGINE: 'self-hosted', MINIONS_SQLITE_PATH: path.resolve('private/db.sqlite'),
  MINIONS_BLOB_DIR: path.resolve('private/media'), MINIONS_OWNER_FILE: path.resolve('private/owner.json') };

test('explicit loopback configuration supports an ephemeral test port', () => {
  expect(selfHostedConfig({ ...env, PORT: '0' })).toMatchObject({ port: 0, host: '127.0.0.1' });
});
test('ambiguous settings fail before database initialization', () => {
  for (const patch of [{ MINIONS_ENGINE: '' }, { MINIONS_ENGINE: 'hosted' },
    { HOST: '0.0.0.0' }, { PORT: '-1' }, { PORT: '65536' }, { TRUST_PROXY: 'true' },
    { MINIONS_OWNER_FILE: undefined }, { MINIONS_OWNER_FILE: 'relative' }, { MINIONS_BLOB_DIR: 'relative' }, { MINIONS_SQLITE_PATH: 'relative.sqlite' }]) {
    expect(() => selfHostedConfig({ ...env, ...patch })).toThrow();
  }
});
test('the database, media folder and owner file must be different locations, however Windows spells them', () => {
  const windows = { ...env, MINIONS_SQLITE_PATH: 'C:\\Users\\Ana Lee\\engine\\db.sqlite', MINIONS_BLOB_DIR: 'C:\\Users\\Ana Lee\\engine\\media',
    MINIONS_OWNER_FILE: 'C:\\Users\\Ana Lee\\engine\\owner.json' };
  expect(selfHostedConfig(windows, path.win32).ownerFile).toBe(windows.MINIONS_OWNER_FILE);
  for (const patch of [{ MINIONS_OWNER_FILE: 'c:\\users\\ana lee\\ENGINE\\DB.SQLITE' }, { MINIONS_OWNER_FILE: 'C:/Users/Ana Lee/engine/db.sqlite' },
    { MINIONS_BLOB_DIR: 'C:\\Users\\Ana Lee\\engine\\media\\..\\db.sqlite' }, { MINIONS_OWNER_FILE: 'C:\\Users\\Ana Lee\\engine\\MEDIA\\' }]) {
    expect(() => selfHostedConfig({ ...windows, ...patch }, path.win32)).toThrow(/separate|own private file/);
  }
  // On any host, a dot segment still names the same file.
  expect(() => selfHostedConfig({ ...env, MINIONS_OWNER_FILE: path.posix.join(path.posix.dirname(env.MINIONS_SQLITE_PATH), '.', 'db.sqlite') }, path.posix)).toThrow('own private file');
});
