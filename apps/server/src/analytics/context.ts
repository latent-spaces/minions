import { FieldPath } from '../firestore.js';
import { z } from 'zod';
import { PROMPT_SOURCES, type ContextNow, type ContextRunPage, type ContextSummary, type ContextTurnPage } from '@mlswarm/contracts';
import { agents, db, inProject } from '../firestore.js';
import { runHistory, turnReceipts, type RunHistory } from '../v2/records.js';
import { encodeCursor, decodeCursor } from '../cursor.js';
import { Refusal } from '../errors.js';
import { authorizePlatformAnalytics, authorizeProjectAnalytics } from './read.js';
import type { CommunityActor } from '../community/identity.js';
const identity=z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const query=z.object({projectId:z.string().regex(/^[a-f0-9]{64}$/).optional(),cursor:z.string().max(1000).optional(),agentId:identity.optional(),runId:z.string().uuid().optional(),after:z.coerce.number().int().nonnegative().optional()}).strict();
function parse(raw:unknown,platform:boolean){const p=query.safeParse(raw);if(!p.success||!platform&&p.data.projectId)throw new Refusal('bad_input','Use an exact run and the current project.');return p.data;}
async function runs(input:z.infer<typeof query>):Promise<ContextRunPage>{
 if(input.agentId||input.runId||input.after!==undefined)throw new Refusal('bad_input','Use the run list cursor.');
 let page=runHistory().orderBy('startedAt','desc').orderBy(FieldPath.documentId(),'desc').limit(21);
 if(input.cursor){const cursor=decodeCursor(input.cursor);if(!cursor||cursor.length!==2||!Number.isSafeInteger(cursor[0])||typeof cursor[1]!=='string'||!/^[a-f0-9]{64}$/.test(cursor[1]))throw new Refusal('bad_input','Use the returned run cursor.');page=page.startAfter(...cursor);}
 const found=await page.get(),rows=found.docs.slice(0,20),ids=[...new Set(rows.map(row=>row.data().agentId))];
 const names=ids.length?await db.getAll(...ids.map(id=>agents().doc(id))):[];
 const labels=new Map(names.map(row=>[row.id,row.data()?.name??null]));
 return {runs:rows.map(row=>{const data=row.data();return {agentId:data.agentId,agentName:labels.get(data.agentId)??null,runId:data.runId,startedAt:data.startedAt,endedAt:data.endedAt??null};}),nextCursor:found.size>20?encodeCursor([rows.at(-1)!.data().startedAt,rows.at(-1)!.id]):null};
}
// Allowlist fields even in historical records; numeric readers never return private prompt payloads.
function summary(context:ContextSummary):ContextSummary{
 const result:ContextSummary={scope:context.scope,coverage:context.coverage,instructionBytes:context.instructionBytes,turnPromptBytes:context.turnPromptBytes,catalogRequests:context.catalogRequests,catalogBytes:context.catalogBytes,
 tools:context.tools.map(t=>({category:t.category,calls:t.calls,argumentBytes:t.argumentBytes,responseTextBytes:t.responseTextBytes,refusals:t.refusals}))};
 if(context.promptSources)result.promptSources=Object.fromEntries(PROMPT_SOURCES.map(key=>[key,context.promptSources![key]])) as Record<typeof PROMPT_SOURCES[number],number>;
 if(context.steeringMessages!==undefined)result.steeringMessages=context.steeringMessages;
 if(context.sessionMode)result.sessionMode=context.sessionMode;
 if(context.byTool)result.byTool=context.byTool.map(t=>({name:t.name,catalogDeliveries:t.catalogDeliveries,definitionBytes:t.definitionBytes,calls:t.calls,argumentBytes:t.argumentBytes,responseTextBytes:t.responseTextBytes,refusals:t.refusals}));
 return result;
}
async function turns(input:z.infer<typeof query>):Promise<ContextTurnPage>{
 if(!input.agentId||!input.runId||input.cursor)throw new Refusal('bad_input','Select an agent run first.');
 let page=turnReceipts().where('agentId','==',input.agentId).where('runId','==',input.runId).orderBy('sequence').limit(51);
 if(input.after!==undefined)page=page.startAfter(input.after);
 const found=await page.get(),rows=found.docs.slice(0,50);
 return {turns:rows.map(row=>turn(row.data())),nextSequence:found.size>50?rows.at(-1)!.data().sequence:null};
}
type Receipt=ReturnType<Awaited<ReturnType<ReturnType<typeof turnReceipts>['get']>>['docs'][number]['data']>;
function turn({lastTurn}:Receipt):ContextTurnPage['turns'][number]{
 const usage=lastTurn.usage!,native=usage.nativeContext;
 return {sequence:usage.sequence,endedAt:lastTurn.endedAt,outcome:lastTurn.outcome,provider:usage.provider??'unknown',model:usage.model,nativeContext:native?{source:native.source,coverage:native.coverage,lastInputTokens:native.lastInputTokens,lastTotalTokens:native.lastTotalTokens,modelContextWindow:native.modelContextWindow,observations:native.observations,completedCompactions:native.completedCompactions}:null,context:usage.context?summary(usage.context):null};
}
// Latest run of each recently active agent with its last turns, oldest first, for the Usage overview.
async function now(input:z.infer<typeof query>):Promise<ContextNow>{
 if(input.cursor||input.agentId||input.runId||input.after!==undefined)throw new Refusal('bad_input','The overview takes no run selection.');
 const recent=await runHistory().orderBy('startedAt','desc').limit(60).get(),latest=new Map<string,RunHistory>();
 for(const row of recent.docs){const run=row.data();if(!latest.has(run.agentId)&&latest.size<12)latest.set(run.agentId,run);}
 const runs=[...latest.values()],names=runs.length?await db.getAll(...runs.map(run=>agents().doc(run.agentId))):[];
 return {agents:await Promise.all(runs.map(async(run,index)=>{
  const found=await turnReceipts().where('agentId','==',run.agentId).where('runId','==',run.runId).orderBy('sequence','desc').limit(12).get();
  return {agentId:run.agentId,agentName:names[index]!.data()?.name??null,runId:run.runId,startedAt:run.startedAt,endedAt:run.endedAt??null,turns:found.docs.map(row=>turn(row.data())).reverse()};
 }))};
}
const read=(kind:'runs'|'turns'|'now',input:z.infer<typeof query>)=>kind==='runs'?runs(input):kind==='turns'?turns(input):now(input);
export async function projectContext(operatorId:string,raw:unknown,kind:'runs'|'turns'|'now'){
 await authorizeProjectAnalytics(operatorId);const input=parse(raw,false);return read(kind,input);
}
export async function platformContext(actor:CommunityActor,raw:unknown,kind:'runs'|'turns'|'now'){
 await authorizePlatformAnalytics(actor);const input=parse(raw,true);if(!input.projectId)throw new Refusal('bad_input','Select one project to inspect its run timeline.');
 return inProject(input.projectId,()=>read(kind,input));
}
