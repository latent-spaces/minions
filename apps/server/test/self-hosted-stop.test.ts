import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { createOwnerFile } from '../src/self-hosted-files.js';
import { lockSelfHostedStore } from '../src/self-hosted-lock.js';
import { selfHostedCli } from './self-hosted-cli.js';

test('stop cannot confirm shutdown while a real lock holder has no listening endpoint', async () => {
  const root = mkdtempSync(join(tmpdir(), 'minions stop '));
  const sqlite = join(root, 'engine.sqlite'), owner = join(root, 'owner.json');
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  const env: NodeJS.ProcessEnv = { ...process.env, MINIONS_ENGINE: 'self-hosted', HOST: '127.0.0.1', PORT: String(port),
    MINIONS_SQLITE_PATH: sqlite, MINIONS_BLOB_DIR: join(root, 'media'), MINIONS_OWNER_FILE: owner };
  for (const name of ['TRUST_PROXY', 'MINIONS_TEST_SESSION', 'MINIONS_TEST_SQLITE_PATH']) delete env[name];
  let held: ReturnType<typeof lockSelfHostedStore> | undefined;
  try {
    createOwnerFile(owner, JSON.stringify({ schema: 1, profileId: 'synthetic-owner',
      owner: { name: 'Synthetic Owner', email: 'owner@example.test', subject: 'synthetic-owner' },
      signingSecret: 'a'.repeat(64), validAfter: 0 }));
    held = lockSelfHostedStore(sqlite);
    const original = readFileSync(`${sqlite}.lock`, 'utf8');
    const stop = () => spawnSync(process.execPath, selfHostedCli(['stop']), { env, encoding: 'utf8', timeout: 10_000 });
    const locked = stop();
    expect(locked.status, locked.stderr).toBe(1);
    expect(locked.stderr).toContain('existing lock');
    expect(readFileSync(`${sqlite}.lock`, 'utf8')).toBe(original);
    held.release(); held = undefined;
    const stopped = stop();
    expect(stopped.status, stopped.stderr).toBe(0);
    expect(stopped.stdout).toContain('No engine answered');
    expect(existsSync(`${sqlite}.lock`)).toBe(false);
  } finally {
    held?.release();
    rmSync(root, { recursive: true, force: true });
  }
});
