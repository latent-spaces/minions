import { randomUUID } from 'node:crypto';
import { disposableTarget, repository } from '../../tests/support/disposable-session.mjs';
disposableTarget();
// Synthetic local MCP context accounting; never run models or inspect participant transcripts.
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import type { AddressInfo } from 'node:net';
const { db, inProject } = await import('../../apps/server/src/firestore.js');
if ((await db.listCollections()).length) throw new Error('Refusing a nonempty test store; no data is reset.');
// Reuse the identified synthetic fixture, not production participant data.
const { seed, seedCurrentStateReady, loadAgent, scoped, TEST_PROJECT } = await import('../../apps/server/test/helpers.js');
const { startRun } = await import('../../apps/server/src/v2/runs.js');
const { sendMessageV2 } = await import('../../apps/server/src/v2/messages.js');
const { v2Routes } = await import('../../apps/server/src/v2/routes.js');
let at = 1_000_000;
await seedCurrentStateReady(); // The disposable store stands in for an initialized engine; find_agents refuses without the receipt.
const fixture = await seed({profiles:[{name:'Synthetic owner',email:'owner@example.com'}],agents:[{name:'amber',person:0},{name:'basil',person:0}]});
const [a,b] = await Promise.all(fixture.agents.map(x=>loadAgent(x.agentId)));
const run = await inProject(TEST_PROJECT,()=>startRun(b.id,{clientRunId: randomUUID(), runnerVersion:'context-diagnostic',takeover:false},()=>at));
const app = createMcpExpressApp(); app.use('/v2',scoped(v2Routes(()=>at)));
const server = app.listen(0,'127.0.0.1'); await once(server,'listening');
const client = new Client({name:'context-diagnostic',version:'1'});
const sizes = (value: unknown) => {
 const text = typeof value === 'string' ? value : JSON.stringify(value);
 const characters = [...text].length;
 return {utf8Bytes:Buffer.byteLength(text),characters,heuristicTokens:Math.ceil(characters/4)};
};
const report: Record<string,unknown> = {source:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',cwd:repository}).trim(),
 sourceWorkingTreeDirty:execFileSync('git',['status','--porcelain'],{encoding:'utf8',cwd:repository}).trim().length>0,
 measuredAt:new Date().toISOString(),scriptSha256:createHash('sha256').update(readFileSync(import.meta.filename)).digest('hex'),synthetic:true,modelsInvoked:0,
 tokenMethod:'Unicode characters / 4, rounded up. Heuristic only; no provider tokenizer, hidden client wrappers or actual context occupancy.',
 actualContextOccupancy:null,providerInputUsage:null,measurements:[]};
const measurements = report.measurements as object[];
try {
 await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v2/mcp`),{requestInit:{headers:{Authorization:`Bearer ${fixture.agents[1].token}`,'X-Pilot-Run':run.run_id}}}));
 const tools = await client.listTools();
 report.catalog = {count:tools.tools.length,...sizes(tools.tools),tools:tools.tools.map(tool=>({name:tool.name,...sizes(tool)}))};
 report.instructions = sizes(readFileSync(new URL('../../packages/agent-cli/runtime/AGENT_PROMPT_V2.md',import.meta.url),'utf8'));
 async function measure(scenario:string,name:string,args:Record<string,unknown>={}) {
  const response = await client.callTool({name,arguments:args});
  if(response.isError) throw new Error(`Synthetic ${name} refused.`);
  const text = (response.content as {type:string;text?:string}[]).filter(c=>c.type==='text').map(c=>c.text??'').join('\n');
  measurements.push({scenario,tool:name,arguments:sizes(args),responseEnvelope:sizes(response),textContent:sizes(text)});
 }
 await measure('empty','get_project'); await measure('empty','find_agents'); await measure('empty','read_agent_inbox');
 let threadId: string | undefined;
 let lastMessageId: string | undefined;
 for(let i=0;i<20;i++) {
  at+=6000;
  const sent=await inProject(TEST_PROJECT,()=>sendMessageV2(a,{to:[b.id],body:'Synthetic coordination detail. '.repeat(60),clientId:`context-${i}`,...(threadId?{threadId}:{})},()=>at));
  threadId??=sent.message.threadId; lastMessageId=sent.message.id;
 }
 await measure('20 messages of 1860 characters','read_agent_inbox');
 await measure('same 20-message thread','read_thread',{thread_id:threadId});
 await measure('already-read thread, no new messages','read_thread',{thread_id:threadId,after_message_id:lastMessageId});
 at+=6000;
 await inProject(TEST_PROJECT,()=>sendMessageV2(a,{to:[b.id],body:'Synthetic coordination detail. '.repeat(60),clientId:'context-new',threadId},()=>at));
 await measure('one new message after 20 already read','read_thread',{thread_id:threadId,after_message_id:lastMessageId});
 report.note='Tool catalog, instructions and responses can recur; do not sum cumulative input usage into one context window. Only one bounded page is measured. MCP text/envelope are both recorded, not assumed to be injected twice. GitHub/code/history/client prompts and community tools are outside this first measurement.';
 if(!process.argv[2]) throw new Error('Provide a report file path.');
 writeFileSync(process.argv[2],JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report,null,2));
} finally {
 await client.close(); server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve())); await db.terminate();
}
