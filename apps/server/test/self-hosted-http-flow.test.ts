// The standalone engine end to end over HTTP, as a person and their coding agents use it: the owner signs in,
// creates and starts a private project with that session and connects two agents; one agent's message reaches
// the other's inbox and is still there after a restart. Every engine process runs under the loopback-only network
// guard, so this also shows the flow needs no outside service. Needs the built viewer (apps/web/dist).
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { selfHostedCli } from './self-hosted-cli.js';

const networkGuard = new URL('../../../tests/support/loopback-only-network-preload.mjs', import.meta.url).href;
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const secret = () => randomBytes(32).toString('base64url');

test('owner session, project and two agents exchange a message over HTTP and it survives a restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'engine http flow ')); chmodSync(root, 0o700);
  const env: NodeJS.ProcessEnv = { ...process.env, MINIONS_ENGINE: 'self-hosted', HOST: '127.0.0.1', PORT: '0',
    MINIONS_SQLITE_PATH: join(root, 'engine.sqlite'), MINIONS_BLOB_DIR: join(root, 'media'), MINIONS_OWNER_FILE: join(root, 'owner.json') };
  for (const name of ['TRUST_PROXY', 'MINIONS_TEST_SESSION', 'MINIONS_TEST_SQLITE_PATH']) delete env[name];
  const networkLogs: string[] = [];
  const guarded = (args: string[]) => {
    const log = join(root, `network-${networkLogs.length}.json`); networkLogs.push(log);
    return { argv: ['--import', networkGuard, ...selfHostedCli(args)], env: { ...env, MINIONS_TEST_NETWORK_LOG: log } };
  };
  const engines: { child: ChildProcess; exit: Promise<number | null> }[] = [];
  async function start() {
    const run = guarded(['start']);
    const child = spawn(process.execPath, run.argv, { env: run.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const exit = new Promise<number | null>(resolve => child.once('exit', resolve)); engines.push({ child, exit });
    let output = '', errors = '';
    child.stderr!.on('data', chunk => { errors += chunk; });
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Startup timed out: ${errors}`)), 15_000);
      child.once('exit', () => { clearTimeout(timer); reject(new Error(`Startup exited: ${errors}`)); });
      child.stdout!.on('data', chunk => { output += chunk; const match = /Standalone engine listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output); if (match) { clearTimeout(timer); resolve(match[1]); } });
    });
    return { url, stop: async () => { child.send('minions-stop'); expect(await exit).toBe(0); } };
  }
  const call = async (url: string, path: string, token?: string, body?: object, profile?: string) => {
    const response = await fetch(url + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}), ...(profile ? { 'X-Minions-Profile-Id': profile } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  // An agent runner's MCP tool call: stateless JSON-RPC over the agent's own token and current run.
  let rpc = 0;
  const tool = async (url: string, project: string, agent: { token: string; run: string }, name: string, args: object) => {
    const response = await fetch(`${url}/p/${project}/v2/mcp`, { method: 'POST', headers: { authorization: `Bearer ${agent.token}`, 'x-pilot-run': agent.run,
      'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpc, method: 'tools/call', params: { name, arguments: args } }) });
    const text = await response.text();
    const data = text.startsWith('{') ? text : text.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('');
    const result = JSON.parse(data).result as { isError?: boolean; content: { text: string }[] };
    expect(result.isError, result.content[0]?.text).toBeFalsy();
    return JSON.parse(result.content[0].text);
  };
  const startRun = async (url: string, project: string, token: string, takeover = false) => {
    const response = await fetch(`${url}/p/${project}/v2/runs`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ client_run_id: randomUUID(), runner_version: 'standalone-smoke', ...(takeover ? { takeover } : {}) }) });
    expect(response.status).toBe(200);
    return (await response.json()).run_id as string;
  };
  try {
    const initialize = guarded(['init', '--owner-name', 'Ada Example', '--owner-email', 'ada@example.test', '--source-revision', 'a'.repeat(40)]);
    const init = spawnSync(process.execPath, initialize.argv, { env: initialize.env, encoding: 'utf8', timeout: 15_000 });
    expect(init.status, init.stderr).toBe(0);

    const first = await start();
    const opened = await fetch(`${first.url}/api/auth/local-owner/session`, { method: 'POST', headers: { origin: first.url, 'content-type': 'application/json' }, body: '{}' });
    const session = (await opened.json()).token as string;

    // The connector signs in with the owner's local session, like the app; there is no computer connection.
    const signedIn = await call(first.url, '/api/owner/profile', session);
    expect(signedIn.status).toBe(200);
    const profile = signedIn.body.profileId as string;

    const created = await call(first.url, '/api/owner/projects/private', session, { githubUrl: 'https://github.com/example/standalone', client_request_id: randomUUID(),
      title: 'Standalone smoke', goal: 'Deliver a message without Google.', approved: true }, profile);
    expect(created.status).toBe(200);
    const project = created.body.projectId as string;
    const added = await call(first.url, `/api/owner/projects/${project}/agents`, session, { names: ['Alpha', 'Beta'], client_request_id: randomUUID(), approved: true }, profile);
    const ids = Object.fromEntries((added.body.agents as { agentId: string; agentName: string }[]).map(agent => [agent.agentName, agent.agentId]));
    expect((await call(first.url, `/api/owner/projects/${project}/control`, session, { client_request_id: randomUUID(), expected_revision: 0, action: 'start', approved: true }, profile)).body.execution).toBe('active');
    const agents: Record<string, { token: string; run: string }> = {};
    for (const name of ['Alpha', 'Beta']) {
      const token = secret();
      expect((await call(first.url, `/api/owner/projects/${project}/agents/connect`, session,
        { name, agentId: ids[name], candidateTokenHash: hash(token), clientName: 'Smoke computer', folder: join(root, name) }, profile)).status).toBe(200);
      agents[name] = { token, run: await startRun(first.url, project, token) };
    }

    const sent = await tool(first.url, project, agents.Alpha, 'send_message', { to: [ids.Beta], body: 'Hello Beta from a standalone engine', client_message_id: 'smoke-1' });
    expect(sent.duplicate).toBe(false);
    const delivered = (inbox: { items: { kind: string; payload: { body?: unknown } }[] }) => inbox.items.filter(item => item.kind === 'message')
      .map(item => JSON.stringify(item.payload.body));
    let inbox = await tool(first.url, project, agents.Beta, 'read_agent_inbox', {});
    for (let i = 0; i < 40 && !delivered(inbox).some(body => body.includes('Hello Beta')); i++) {
      await new Promise(resolve => setTimeout(resolve, 250)); inbox = await tool(first.url, project, agents.Beta, 'read_agent_inbox', {});
    }
    expect(delivered(inbox).join()).toContain('Hello Beta from a standalone engine');
    await first.stop();

    // A restarted engine still has the project, Beta's credentials and the unacknowledged message.
    const second = await start();
    agents.Beta.run = await startRun(second.url, project, agents.Beta.token, true);
    expect(delivered(await tool(second.url, project, agents.Beta, 'read_agent_inbox', {})).join()).toContain('Hello Beta from a standalone engine');
    await second.stop();

    // init plus two engine runs; a missing log (a process that did not exit normally) throws here.
    expect(networkLogs).toHaveLength(3);
    for (const log of networkLogs) expect(JSON.parse(readFileSync(log, 'utf8')), log).toEqual([]);
  } finally {
    for (const { child, exit } of engines) if (child.exitCode === null) { child.send('minions-stop'); await exit; }
    rmSync(root, { recursive: true, force: true });
  }
}, 90_000);
