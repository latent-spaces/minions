import { z } from 'zod';
import type { UsageAnalytics } from '@minions/contracts';
import { db, currentProjectId } from '../firestore.js';
import { assertMembership } from '../projects/access.js';
import { assertCommunityActor, type CommunityActor } from '../community/identity.js';
import { Refusal } from '../errors.js';
import { metricsBuckets, metricsPending } from './projection.js';
import { cardDoc } from '../projects/card.js';
import { emptyValues, mergeValues } from './values.js';
const day=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s=>{try{return new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s;}catch{return false;}});
const base={from:day,to:day,provider:z.enum(['claude','codex','unknown']).optional(),model:z.string().min(1).max(150).optional()};
const projectQuery=z.object(base).strict();
const platformQuery=z.object({...base,projectId:z.string().regex(/^[a-f0-9]{64}$/).optional(),groupBy:z.enum(['model','project']).default('project')}).strict();
async function read(raw:unknown,platform:boolean,now:()=>number):Promise<UsageAnalytics> {
  const parsed=platformQuery.safeParse(raw);
  if(!parsed.success || !platform && !projectQuery.safeParse(raw).success) throw new Refusal('bad_input','Choose UTC dates and supported analytics filters.');
  const input=parsed.data, from=Date.parse(input.from+'T00:00:00Z'),to=Date.parse(input.to+'T00:00:00Z');
  if(to<from || to-from>30*86400000) throw new Refusal('bad_input','Choose up to 31 UTC days.');
  const projectId=platform ? input.projectId : currentProjectId();
  const groupBy=platform ? input.groupBy : 'model';
  let query=metricsBuckets().where('day','>=',input.from).where('day','<=',input.to);
  if(projectId) query=query.where('projectId','==',projectId);
  if(input.provider) query=query.where('provider','==',input.provider);
  if(input.model) query=query.where('model','==',input.model);
  const [rows,pending]=await Promise.all([query.limit(2001).get(),
    (projectId ? metricsPending().where('projectId','==',projectId) : metricsPending()).limit(2001).count().get()]);
  if(rows.size>2000) throw new Refusal('bad_input','This range has too many series. Narrow the dates or select a project, provider or model.');
  const totals=emptyValues(), points=new Map<string,UsageAnalytics['points'][number]>(), groups=new Map<string,UsageAnalytics['groups'][number]>();
  for(let date=from;date<=to;date+=86400000) {const day=new Date(date).toISOString().slice(0,10);points.set(day,{day,...emptyValues()});}
  let lastProjectedAt:number|null=null;
  for(const doc of rows.docs) {
    const row=doc.data();
    mergeValues(totals,row);mergeValues(points.get(row.day)!,row);
    const key=groupBy==='project'?row.projectId:JSON.stringify([row.provider,row.model]);
    let group=groups.get(key);
    if(!group) {group={key,label:groupBy==='project'?`Project ${row.projectId.slice(0,8)}`:`${row.provider} / ${row.model??'Unreported model'}`,provider:groupBy==='project'?'all':row.provider,model:groupBy==='project'?null:row.model,projectId:groupBy==='project'?row.projectId:projectId??null,...emptyValues()};groups.set(key,group);}
    mergeValues(group,row);lastProjectedAt=Math.max(lastProjectedAt??0,row.projectedAt);
  }
  if(groups.size>100) throw new Refusal('bad_input','Choose a narrower filter to show at most 100 groups.');
  if(groupBy==='project' && groups.size) {
    const labels=await db.getAll(...[...groups.values()].map(group=>cardDoc(group.projectId!)));
    for(const [index,group] of [...groups.values()].entries()) group.label=labels[index]?.data()?.definition.title??group.label;
  }
  return {schema:1,timeBasis:'reported-completion-utc',scope:platform?'platform':'project',projectId:projectId??null,
    from:input.from,to:input.to,generatedAt:now(),lastProjectedAt,coverage:'projected-received-reports',historyCoverage:'not-verified',pendingReports:pending.data().count,pendingReportsCapped:pending.data().count===2001,contextScope:'partial-minions-supplied',
    totals,points:[...points.values()],groups:[...groups.values()].sort((a,b)=>b.reports-a.reports)};
}
export async function authorizeProjectAnalytics(operatorId:string) {
  await db.runTransaction(tx=>assertMembership(tx,operatorId),{readOnly:true});
}
export async function authorizePlatformAnalytics(actor:CommunityActor) {
  await db.runTransaction(async tx=>{if(!(await assertCommunityActor(tx,actor)).canAdminPlatform) throw new Refusal('forbidden','Only platform administrators can read cross-project analytics.');},{readOnly:true});
}
export async function readProjectAnalytics(operatorId:string,query:unknown,now:()=>number) {
  await authorizeProjectAnalytics(operatorId);return read(query,false,now);
}
export async function readPlatformAnalytics(actor:CommunityActor,query:unknown,now:()=>number) {
  await authorizePlatformAnalytics(actor);return read(query,true,now);
}
