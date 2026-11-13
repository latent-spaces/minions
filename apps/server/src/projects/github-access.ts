import type { Transaction } from '../firestore.js';
import { z } from 'zod';
import type { GitHubAccessObservation, GitHubCachedFacts, GitHubPullRequestCounts, ProjectMergingAccess } from '@mlswarm/contracts';
import { collection, db, inProject } from '../firestore.js';
import { computerConnections, currentComputer, COMPUTER_DISCONNECTED } from '../owner/computer-access.js';
import { Refusal } from '../errors.js';
import { activeRecipientOperators, assertMembership } from './access.js';
import { projects } from './records.js';
import { canonicalGithubRepo } from '@mlswarm/contracts';
import { runtimeReadiness, readinessView } from '../owner/web-agent-starts.js';

const login = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/);
const text = z.string().min(1).max(200).refine(value => !/[\x00-\x1f\x7f]/.test(value));
const statuses = z.enum(['ok','signed_out','missing','forbidden','unavailable','rate_limited','failed','not_checked']);
const fact = <T extends z.ZodType>(value: T) => z.object({status: statuses, value: value.nullable()}).strict().refine(value => { const observed=value as {status:string;value:unknown}; return (observed.status === 'ok') === (observed.value !== null); });
const approvals = z.number().int().min(0).max(100).nullable();
const checks = z.array(text).max(100);
const REPORT = z.object({version:z.literal(1),membershipEpoch:z.number().int().nonnegative(),projectId:z.string().regex(/^[a-f0-9]{64}$/),repository:z.string().max(500),checkedAt:z.number().int().nonnegative(),
  account:fact(z.object({login}).strict()),
  access:fact(z.object({role:z.enum(['admin','maintain','write','triage','read','none']).nullable(),defaultBranch:text}).strict()),
  collaborators:fact(z.object({people:z.array(z.object({login,role:text}).strict()).max(100),complete:z.boolean()}).strict()),
  invitations:fact(z.object({people:z.array(z.object({login,invitedBy:login.nullable()}).strict()).max(100),complete:z.boolean()}).strict()),
  rules:fact(z.object({types:z.array(text).max(100),requiredApprovals:approvals,requiredChecks:checks,complete:z.boolean()}).strict()),
  protection:fact(z.object({requiredApprovals:approvals,requiredChecks:checks,pullRequests:z.boolean(),enforceAdmins:z.boolean()}).strict()),
  pullRequests:fact(z.object({open:z.number().int().min(0).max(500),drafts:z.number().int().min(0).max(500),merged:z.number().int().min(0).max(500).optional(),complete:z.boolean()}).strict().refine(value=>value.drafts<=value.open)).optional(),
}).strict();

type Saved = GitHubCachedFacts & {pullRequests?:GitHubPullRequestCounts & {lastSuccessAt:number|null};profileId:string;connectionId:string;repository:string;epoch:number;checkedAt:number;receivedAt:number;scope:'self'|'project'};
const observations = (id:string) => collection<Saved>(`projects/${id}/githubAccess`);
const fields = ['account','access','collaborators','invitations','rules','protection'] as const;
const projectFields = ['collaborators','invitations','rules','protection'] as const;

export async function publishGitHubAccess(profileId:string,connectionId:string,input:unknown,now:()=>number) {
  if(Buffer.byteLength(JSON.stringify(input) ?? '', 'utf8') > 128*1024) throw new Refusal('bad_input','GitHub observation is too large.');
  const parsed = REPORT.safeParse(input);
  if(!parsed.success) throw new Refusal('bad_input','Invalid GitHub observation.');
  const report = parsed.data, repository = canonicalGithubRepo(report.repository);
  if(report.account.status!=='ok' && fields.some(field=>field!=='account' && report[field].status==='ok')) throw new Refusal('bad_input','GitHub facts require a checked account.');
  if(report.pullRequests?.status==='ok' && (report.account.status!=='ok'||report.access.status!=='ok')) throw new Refusal('bad_input','PR counts require checked repository access.');
  if(!repository) throw new Refusal('bad_input','Use the connected GitHub repository.');
  return inProject(report.projectId,()=>db.runTransaction(async tx=>{
    const at=now();
    if(report.checkedAt > at+30000 || report.checkedAt < at-10*60000) throw new Refusal('bad_input','GitHub observation expired. Check again.');
    const role=await assertMembership(tx,profileId), eligible=await activeRecipientOperators(tx,[profileId]);
    const [computer,project,previous]=await Promise.all([tx.get(computerConnections.doc(connectionId)),tx.get(projects.doc(report.projectId)),tx.get(observations(report.projectId).doc(connectionId))]);
    if(!currentComputer(computer.data(),profileId)) throw new Refusal('unauthorized',COMPUTER_DISCONNECTED);
    if(canonicalGithubRepo(project.data()?.setup.repoUrl)!==repository) throw new Refusal('forbidden','The connected repository changed. Check again.');
    const scope = role === 'owner' ? 'project' : 'self';
    if(scope==='self' && projectFields.some(field=>report[field].status!=='not_checked')) throw new Refusal('forbidden','Only the project owner can report shared GitHub access.');
    if(scope==='self' && report.pullRequests && report.pullRequests.status!=='not_checked') throw new Refusal('forbidden','Only the project owner can report shared PR counts.');
    const epoch=eligible.get(profileId)!.epoch, old=previous.data();
    if(report.membershipEpoch!==epoch) throw new Refusal('forbidden','Project membership changed. Check again.');
    const reusable = old?.profileId===profileId && old.repository===repository && old.epoch===epoch;
    if(reusable && report.checkedAt <= old.checkedAt) return {ok:true,serverTime:at};
    const sameAccount = reusable && !(report.account.status==='ok' && old.account.value?.login.toLowerCase()!==report.account.value!.login.toLowerCase());
    const branchChanged=report.access.status==='ok' && old?.access.value?.defaultBranch!==report.access.value!.defaultBranch;
    const facts=Object.fromEntries(fields.map(field=>{
      const preserve=sameAccount && !(branchChanged && (field==='rules'||field==='protection')) && !(scope==='self' && projectFields.includes(field as typeof projectFields[number]));
      return [field,{status:report[field].status,value:report[field].status==='ok'?report[field].value:preserve?old[field].value:null,
        lastSuccessAt:report[field].status==='ok'?at:preserve?old[field].lastSuccessAt:null}];
    })) as GitHubCachedFacts;
    const pr=report.pullRequests, preserve=scope==='project' && sameAccount;
    const pullRequests = pr ? {status:pr.status,value:pr.status==='ok'?pr.value:preserve?old?.pullRequests?.value??null:null,
      lastSuccessAt:pr.status==='ok'?at:preserve?old?.pullRequests?.lastSuccessAt??null:null}
      : preserve?old?.pullRequests:undefined;
    tx.set(observations(report.projectId).doc(connectionId),{...facts,...(pullRequests?{pullRequests}:{}),profileId,connectionId,repository,epoch,checkedAt:report.checkedAt,receivedAt:at,scope});
    return {ok:true,serverTime:at};
  }));
}

export async function mergingGitHubAccess(tx:Transaction,id:string,repository:string|null,peopleIds:string[],at:number,forPullRequests=false):Promise<ProjectMergingAccess['github']> {
  const found=await tx.get(observations(id).orderBy('receivedAt','desc').limit(51)), rows=found.docs.slice(0,50).map(row=>row.data());
  const operators=await activeRecipientOperators(tx,rows.map(row=>row.profileId));
  const documents=rows.length?await tx.getAll(...rows.map(row=>computerConnections.doc(row.connectionId))):[];
  const readiness=rows.length?await tx.getAll(...rows.map(row=>runtimeReadiness.doc(row.connectionId))):[];
  const result:ProjectMergingAccess['github']={project:null,self:[],more:found.size>50};
  const included=new Set<string>();
  for(const [index,row] of rows.entries()) {
    const operator=operators.get(row.profileId);
    if(!operator || operator.epoch!==row.epoch || row.repository!==canonicalGithubRepo(repository) || !currentComputer(documents[index].data(),row.profileId)) continue;
    const shared=row.scope==='project' && operator.role==='owner';
    if(row.scope==='project' && !shared) continue;
    const ready=readiness[index].data();
    const value:GitHubAccessObservation={...Object.fromEntries(fields.map(field=>[field,row[field]])) as GitHubCachedFacts,
      ...(row.pullRequests?{pullRequests:row.pullRequests}:{}),
      observer:{id:row.profileId,name:operator.name},connectionId:row.connectionId,checkedAt:row.checkedAt,receivedAt:row.receivedAt,
      online:ready?.profileId===row.profileId && ready.connectionId===row.connectionId && !!readinessView(ready,at)?.online,scope:shared?'project':'self'};
    if(shared && (!forPullRequests ? !result.project : row.pullRequests?.value && (row.pullRequests.lastSuccessAt??0) > (result.project?.pullRequests?.lastSuccessAt??-1))) result.project=value;
    if(peopleIds.includes(row.profileId) && !included.has(row.profileId)) {result.self.push(value);included.add(row.profileId);}
  }
  return result;
}
