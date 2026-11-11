import { useEffect, useState } from 'react';
import type { ContextNow, UsageAnalytics as Data } from '@mlswarm/contracts';
import { UsageAnalyticsView, type AnalyticsFilters as Filters } from './ui/UsageAnalytics';
type Request = <T>(path:string)=>Promise<T>;
const initial=():Filters=>{const to=new Date().toISOString().slice(0,10);return {to,from:new Date(Date.parse(to)-6*86400000).toISOString().slice(0,10),provider:'',model:'',projectId:'',groupBy:'project'};};
export function UsageAnalytics({request,scope,platform=false}:{request:Request;scope:string;platform?:boolean}) {
  return <ScopedUsageAnalytics key={scope} request={request} platform={platform}/>;
}
function ScopedUsageAnalytics({request,platform}:{request:Request;platform:boolean}) {
  const [filters,setFilters]=useState(initial),[applied,setApplied]=useState(initial);
  const [projectLabel,setProjectLabel]=useState<{id:string;label:string}|null>(null);
  const [data,setData]=useState<Data|null>(null),[now,setNow]=useState<ContextNow|'error'|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(true),[tick,setTick]=useState(0);
  useEffect(()=>{
    let current=true;setBusy(true);setData(null);setError('');
    const query=new URLSearchParams({from:applied.from,to:applied.to});
    for(const key of ['provider','model'] as const)if(applied[key])query.set(key,applied[key]);
    if(platform){query.set('groupBy',applied.groupBy);if(applied.projectId)query.set('projectId',applied.projectId);}
    request<Data>(`${platform?'/analytics':'/usage/analytics'}?${query}`).then(value=>{if(current)setData(value);},reason=>{if(current)setError(reason instanceof Error?reason.message:'Could not load measurements. Try again.');}).finally(()=>{if(current)setBusy(false);});
    return ()=>{current=false;};
  },[request,applied,platform,tick]);
  // The latest-turn overview ignores date filters; it follows the selected project.
  useEffect(()=>{
    let current=true;setNow(null);
    if(platform&&!applied.projectId)return;
    request<ContextNow>(platform?`/analytics/context-now?${new URLSearchParams({projectId:applied.projectId})}`:'/usage/context-now').then(value=>{if(current)setNow(value);},()=>{if(current)setNow('error');});
    return ()=>{current=false;};
  },[request,platform,applied.projectId,tick]);
  return <UsageAnalyticsView filters={filters} setFilters={setFilters} apply={()=>{setApplied({...filters});setTick(n=>n+1);}}
    refresh={()=>setTick(n=>n+1)} projectLabel={projectLabel?.id===data?.projectId?projectLabel?.label:undefined} drill={projectId=>{const group=data?.groups.find(g=>g.projectId===projectId);setProjectLabel(group?{id:projectId,label:group.label}:null);const next={...applied,projectId,groupBy:projectId?'model':'project'};setFilters(next);setApplied(next);}}
    data={data} now={now} error={error} busy={busy} platform={platform}/>;
}
