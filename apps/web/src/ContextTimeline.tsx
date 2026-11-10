import {useEffect,useState} from 'react';
import type {ContextRunPage,ContextTurnPage} from '@mlswarm/contracts';
import {ContextTimelineView} from './ui/ContextTimeline';
type Request=<T>(path:string)=>Promise<T>;
export function ContextTimeline({request,platform,projectId}:{request:Request;platform:boolean;projectId:string|null}){
 if(platform&&!projectId)return null;
 return <ScopedTimeline key={`${platform}:${projectId??'current'}`} request={request} platform={platform} projectId={projectId}/>;
}
function ScopedTimeline({request,platform,projectId}:{request:Request;platform:boolean;projectId:string|null}){
 const [runCursors,setRunCursors]=useState<(string|undefined)[]>([undefined]),[turnCursors,setTurnCursors]=useState<(number|undefined)[]>([undefined]);
 const [runs,setRuns]=useState<ContextRunPage|null>(null),[selected,setSelected]=useState<ContextRunPage['runs'][number]|null>(null);
 const [turnState,setTurnState]=useState<{key:string;page:ContextTurnPage}|null>(null),[error,setError]=useState(''),[busyRuns,setBusyRuns]=useState(false),[busyTurns,setBusyTurns]=useState(false),[tick,setTick]=useState(0);
 const runCursor=runCursors.at(-1),after=turnCursors.at(-1),turnKey=JSON.stringify([selected?.agentId,selected?.runId,after]);
 const path=(kind:string,q:URLSearchParams)=>{if(platform)q.set('projectId',projectId!);return `${platform?'/analytics':'/usage'}/context-${kind}?${q}`;};
 useEffect(()=>{
  let current=true;setRuns(null);setSelected(null);setTurnState(null);setError('');setBusyRuns(true);setBusyTurns(false);
  const q=new URLSearchParams();if(runCursor)q.set('cursor',runCursor);
  request<ContextRunPage>(path('runs',q)).then(page=>{if(current){setRuns(page);setSelected(page.runs[0]??null);setTurnCursors([undefined]);}},e=>{if(current)setError(e instanceof Error?e.message:'Could not load runs.');}).finally(()=>{if(current)setBusyRuns(false);});
  return()=>{current=false;};
 },[request,platform,projectId,runCursor,tick]);
 useEffect(()=>{
  if(!selected)return;let current=true;setTurnState(null);setError('');setBusyTurns(true);
  const q=new URLSearchParams({agentId:selected.agentId,runId:selected.runId});if(after!==undefined)q.set('after',String(after));
  request<ContextTurnPage>(path('turns',q)).then(page=>{if(current)setTurnState({key:turnKey,page});},e=>{if(current){setError(e instanceof Error?e.message:'Could not load turns.');setRuns(null);setSelected(null);}}).finally(()=>{if(current)setBusyTurns(false);});
  return()=>{current=false;};
 },[request,platform,projectId,selected,after,turnKey]);
 const safeTurns=turnState?.key===turnKey?turnState.page:null;
 return <ContextTimelineView runs={runs} selected={selected?.runId??''} turns={safeTurns} busy={busyRuns||busyTurns} error={error}
   select={runId=>{setTurnState(null);setTurnCursors([undefined]);setSelected(runs?.runs.find(run=>run.runId===runId)??null);}}
   previousRuns={runCursors.length>1?()=>setRunCursors(c=>c.slice(0,-1)):undefined} nextRuns={runs?.nextCursor?()=>setRunCursors(c=>[...c,runs.nextCursor!]):undefined}
   previousTurns={turnCursors.length>1?()=>setTurnCursors(c=>c.slice(0,-1)):undefined} nextTurns={safeTurns?.nextSequence!==null&&safeTurns?.nextSequence!==undefined?()=>setTurnCursors(c=>[...c,safeTurns.nextSequence!]):undefined}
   retry={()=>setTick(n=>n+1)}/>;
}
