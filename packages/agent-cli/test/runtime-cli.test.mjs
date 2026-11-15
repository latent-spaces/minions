import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, chmod, link, symlink, writeFile, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { z } from 'zod/v4';
import { publishRuntimeEndpoint, readRuntimeEndpoint } from '../src/service/endpoint-file.mjs';
import { createRuntimeClient } from '../src/service/local-client.mjs';
import { main } from '../src/cli.mjs';

const principal = { site: 'https://synthetic.invalid', ownerId: 'synthetic-owner' };
const identity = () => ({ version: 2, incarnation: randomUUID(), pid: process.pid, transport: 'streamable-http', cloudReady: false });
const record = home => ({ home, url: 'http://127.0.0.1:12345/mcp', token: randomBytes(32).toString('hex'), identity: identity(), principal });
async function temporary(t) {
  const home = await mkdtemp(join(tmpdir(), 'minions-runtime-cli-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}
async function gateway(t, { redirect = null } = {}) {
  const home = await temporary(t), selected = record(home), calls = [];
  const handler = createMcpHandler(() => {
    const mcp = new McpServer({ name: 'synthetic-runtime-cli', version: '0.0.0-test' });
    mcp.registerTool('get_computer_status', { inputSchema: z.object({}).strict() }, async () => ({ content: [{ type: 'text', text: JSON.stringify(selected.identity) }] }));
    for (const name of ['list_my_projects', 'recover_agent_run', 'control_agent']) {
      mcp.registerTool(name, { inputSchema: z.record(z.string(), z.unknown()) }, async args => {
        calls.push({ name, args });
        return { content: [{ type: 'text', text: JSON.stringify({ synthetic: true, name, args }) }] };
      });
    }
    return mcp;
  });
  const node = toNodeHandler(handler);
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${selected.token}`);
    if (redirect) { res.writeHead(307, { location: redirect }); res.end(); return; }
    void node(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  selected.url = `http://127.0.0.1:${server.address().port}/mcp`;
  await publishRuntimeEndpoint(selected);
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await handler.close(); });
  return { home, selected, calls };
}

test('endpoint discovery refuses exposed, linked, oversized, malformed and foreign records', async t => {
  const home = await temporary(t), selected = record(home), path = join(home, 'runtime-endpoint.json');
  await publishRuntimeEndpoint(selected);
  const valid = readRuntimeEndpoint(home);
  await chmod(path, 0o644);
  if (process.platform !== 'win32') assert.throws(() => readRuntimeEndpoint(home), /endpoint/);
  await chmod(path, 0o600);
  const extra = join(home, 'extra'); await link(path, extra);
  assert.throws(() => readRuntimeEndpoint(home), /endpoint/);
  await unlink(extra);
  await unlink(path); await writeFile(extra, JSON.stringify(valid), { mode: 0o600 }); await symlink(extra, path);
  assert.throws(() => readRuntimeEndpoint(home), /endpoint/);
  await unlink(path);
  for (const value of ['not json', 'x'.repeat(9000), JSON.stringify({ ...valid, owner_ref: 'retired' }), ...[
    'https://127.0.0.1:12345/mcp', 'http://localhost:12345/mcp', 'http://127.0.0.1:12345/mcp?token=secret',
    'http://user:secret@127.0.0.1:12345/mcp', 'http://foreign.invalid:12345/mcp',
  ].map(url => JSON.stringify({ ...valid, url }))]) {
    await writeFile(path, value, { mode: 0o600 }); assert.throws(() => readRuntimeEndpoint(home), /endpoint/);
  }
});

test('local MCP discovery never follows redirects or sends credentials to another endpoint', async t => {
  let foreignRequests = 0;
  const foreign = http.createServer((_req, res) => { foreignRequests++; res.end('{}'); });
  await new Promise(resolve => foreign.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => foreign.close(resolve)));
  const { home } = await gateway(t, { redirect: `http://127.0.0.1:${foreign.address().port}/mcp` });
  const client = createRuntimeClient({ home }); t.after(() => client.close());
  await assert.rejects(client.callTool('list_my_projects', {}), /Shared runtime/);
  assert.equal(foreignRequests, 0);
});

test('recovery CLI requires exact approval, generation and observations before reaching the shared owner service',async t=>{
  const {home,calls}=await gateway(t),missionId=randomUUID(),operationId=randomUUID();
  const flags=['--state-dir',home,'--mission',missionId,'--project','park','--agent','claude',
    '--generation','2','--request-id',operationId,'--reason','Close this interrupted mission'];
  const output=[];
  assert.equal(await main(['run-recover',...flags,'--action','finalize','--approve'],line=>output.push(line),()=>assert.fail('CLI failed')),0);
  assert.equal(calls.at(-1).name,'recover_agent_run');assert.equal(calls.at(-1).args.approved,true);assert.equal(calls.at(-1).args.generation,2);
  assert.ok(!Object.hasOwn(calls.at(-1).args,'version'));
  assert.deepEqual(calls.at(-1).args.target,{projectId:'park',agentId:'claude'});
  const report='a'.repeat(64);
  assert.equal(await main(['run-recover',...flags,'--action','retry_report','--approve','--report',report,'--attempts','3','--error-code','unauthorized'],()=>{},()=>assert.fail('CLI failed')),0);
  assert.equal(calls.at(-1).args.reportId,report);assert.equal(calls.at(-1).args.expectedAttempts,3);
  const archiveFlags=flags.filter((value,index)=>value!=='--generation' && flags[index-1]!=='--generation');
  assert.equal(await main(['run-recover',...archiveFlags,'--action','archive_failed_launch_report','--approve','--report',report,'--error-code','run_superseded'],()=>{},()=>assert.fail('Archive CLI failed')),0);
  assert.equal(calls.at(-1).args.action,'archive_failed_launch_report');
  assert.ok(!Object.hasOwn(calls.at(-1).args,'generation'));
  const before=calls.length;
  for(const extra of [['--action','finalize'],['--action','finalize','--approve','--report',report],
    ['--action','retry_report','--approve','--report',report,'--attempts','-1','--error-code','unauthorized'],
    ['--action','finalize','--approve','--force']])assert.equal(await main(['run-recover',...flags,...extra],()=>assert.fail('Unexpected success'),()=>{}),2);
  assert.equal(calls.length,before);
});

test('CLI Pause/Resume uses exact owner mission and Pause IDs with explicit approval', async t => {
  const {home,calls}=await gateway(t),mission=randomUUID(),pause=randomUUID();
  const flags=['--state-dir',home,'--mission',mission,
    '--project','park','--agent','codex','--generation','2','--request-id',pause,'--approve'];
  assert.equal(await main(['run-pause',...flags],()=>{},()=>{}),0);
  assert.deepEqual(calls.at(-1),{name:'control_agent',args:{operationId:pause,missionId:mission,
    target:{projectId:'park',agentId:'codex'},generation:2,kind:'pause',payload:{}}});
  const next=randomUUID(),resumeFlags=flags.map(value=>value===pause?next:value);
  assert.equal(await main(['run-resume',...resumeFlags,'--pause-request',pause],()=>{},()=>{}),0);
  assert.equal(calls.at(-1).args.kind,'resume');assert.deepEqual(calls.at(-1).args.payload,{pauseOperationId:pause});
  const count=calls.length;
  for(const args of [['run-pause',...flags.filter(value=>value!=='--approve')],
    ['run-resume',...resumeFlags],['run-pause',...flags,'--deadline','9000000000000'],
    ['run-resume',...resumeFlags,'--pause-request','invalid']])assert.equal(await main(args,()=>{},()=>{}),2);
  assert.equal(calls.length,count,'Invalid control never reaches the service');
});


test('retired waiting-room command is rejected without contacting the service', async t => {
  const { home, calls } = await gateway(t), errors = [];
  assert.equal(await main(['waiting-room', '--project', 'a'.repeat(64), '--state-dir', home], () => {}, value => errors.push(value)), 2);
  assert.equal(calls.length, 0);
  assert.ok(errors.length > 0);
});
