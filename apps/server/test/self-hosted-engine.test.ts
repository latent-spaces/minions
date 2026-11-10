// A real CLI process must initialize and reopen the persistent adapter, then drain before unlocking it.
import { request } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { selfHostedCli } from './self-hosted-cli.js';

// Every engine process runs under the loopback-only network guard and reports what it refused.
const networkGuard = new URL('../../../tests/support/loopback-only-network-preload.mjs', import.meta.url).href;
test('a fresh standalone CLI initializes, signs in its ordinary owner, shuts down and reopens its database', async () => {
  const root = mkdtempSync(join(tmpdir(), 'engine CLI with spaces ')); chmodSync(root, 0o700);
  const env: NodeJS.ProcessEnv & { MLSWARM_SQLITE_PATH: string; MLSWARM_OWNER_FILE: string } = { ...process.env, MLSWARM_ENGINE: 'self-hosted', MLSWARM_SIGN_IN: 'local-owner', HOST: '127.0.0.1', PORT: '0',
    MLSWARM_SQLITE_PATH: join(root, 'engine.sqlite'), MLSWARM_BLOB_DIR: join(root, 'media'), MLSWARM_OWNER_FILE: join(root, 'owner.json') };
  for (const name of ['TRUST_PROXY', 'MLSWARM_TEST_SESSION', 'MLSWARM_TEST_SQLITE_PATH']) delete env[name];
  const networkLogs: string[] = [];
  const guarded = (args: string[]) => {
    const log = join(root, `network-${networkLogs.length}.json`); networkLogs.push(log);
    return { argv: ['--import', networkGuard, ...selfHostedCli(args)], env: { ...env, MLSWARM_TEST_NETWORK_LOG: log } };
  };
  const command = (...args: string[]) => { const run = guarded(args); return spawnSync(process.execPath, run.argv, { env: run.env, encoding: 'utf8', timeout: 15_000 }); };
  try {
    const init = command('init', '--owner-name', 'Ada Example', '--owner-email', 'ada@example.test', '--source-revision', 'a'.repeat(40));
    expect(init.status, init.stderr).toBe(0);
    const bytes = readFileSync(env.MLSWARM_OWNER_FILE, 'utf8');
    const refused = command('init', '--owner-name', 'Other', '--owner-email', 'other@example.test', '--source-revision', 'b'.repeat(40));
    expect(refused.status).toBe(1); expect(readFileSync(env.MLSWARM_OWNER_FILE, 'utf8')).toBe(bytes);
    let firstToken = '';
    for (let round = 0; round < 2; round++) {
      const linkFile = join(root, `link-${round}.txt`);
      const run = guarded(['start', '--link-file', linkFile]);
      const child = spawn(process.execPath, run.argv, { env: run.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      let output = '', errors = '';
      child.stderr!.on('data', chunk => { errors += chunk; });
      const exit = new Promise<number | null>(resolve => child.once('exit', resolve));
      try {
        const url = await new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`Startup timed out: ${errors}`)), 15_000);
          child.once('exit', () => { clearTimeout(timer); reject(new Error(`Startup exited: ${errors}`)); });
          child.stdout!.on('data', chunk => { output += chunk; const match = /Standalone engine listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output); if (match) { clearTimeout(timer); resolve(match[1]); } });
        });
        const rebound = await new Promise<number | undefined>((resolve, reject) => {
          const req = request(`${url}/integrations/github`, { headers: { host: 'rebound.example' } }, res => { res.resume(); resolve(res.statusCode); });
          req.on('error', reject); req.end();
        });
        expect(rebound).toBe(403); // Includes unauthenticated routes mounted before the MCP SDK guard.
        const duplicate = command('start', '--link-file', join(root, `duplicate-${round}.txt`));
        expect(duplicate.status, duplicate.stderr).toBe(1);
        expect(duplicate.stderr).toContain('database is locked');
        expect(existsSync(`${env.MLSWARM_SQLITE_PATH}.lock`)).toBe(true);
        const link = new URL(readFileSync(linkFile, 'utf8').trim());
        expect(link.origin).toBe(url);
        const code = new URLSearchParams(link.hash.slice(1)).get('mlswarm_owner_code')!;
        expect(output).not.toContain(code); expect(errors).not.toContain(code);
        const response = await fetch(`${url}/api/auth/local-owner/exchange`, { method: 'POST', headers: { origin: url, 'content-type': 'application/json' },
          body: JSON.stringify({ code, client_state: 's'.repeat(43) }) });
        expect(response.status).toBe(200);
        const session = await response.json(); expect(session.token).toMatch(/^lo1\./);
        expect(output).not.toContain(session.token);
        expect(output + errors).not.toContain(JSON.parse(bytes).signingSecret);
        const identity = await fetch(`${url}/api/auth/session`, { headers: { authorization: `Bearer ${session.token}` } });
        expect(await identity.json()).toMatchObject({ email: 'ada@example.test', displayName: 'Ada Example' });
        if (!round) firstToken = session.token;
        else expect((await fetch(`${url}/api/auth/session`, { headers: { authorization: `Bearer ${firstToken}` } })).status).toBe(200);
        const refresh = command('owner-link', '--url', url, '--link-file', join(root, `refreshed-${round}.txt`));
        expect(refresh.status, refresh.stderr).toBe(0);
        expect(refresh.stdout).not.toMatch(/lo1\.|mlswarm_owner_code=/);
        // Both stop routes drain and unlock: the supervisor's IPC message, then Ctrl+C (SIGINT).
        if (round) child.kill('SIGINT'); else child.send('mlswarm-stop');
        expect(await exit).toBe(0);
        expect(existsSync(`${env.MLSWARM_SQLITE_PATH}.lock`)).toBe(false);
      } finally { if (child.exitCode === null) { child.send('mlswarm-stop'); await exit; } }
    }
    // No engine process tried to reach a non-loopback host. A missing log (a process that died without
    // exiting normally) throws here rather than counting as nothing refused.
    expect(networkLogs).toHaveLength(8); // init, refused init, then start + refused duplicate + owner-link per round
    for (const log of networkLogs) expect(JSON.parse(readFileSync(log, 'utf8')), log).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);
