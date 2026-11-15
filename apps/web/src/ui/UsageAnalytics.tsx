import { useId } from 'react';
import type { ContextNow, UsageAnalytics as Data } from '@minions/contracts';
import { Button } from './Button';
import { AgentNow, Outcomes, TopTools } from './UsageOverview';
import './usage-analytics.css';
import { InfoTip } from './InfoTip';

export type AnalyticsFilters = { from: string; to: string; provider: string; model: string; projectId: string; groupBy: string };

export function UsageAnalyticsView({filters,setFilters,apply,refresh,drill,data,now,error,busy,platform,projectLabel}: {
  filters:AnalyticsFilters;setFilters:(update:(previous:AnalyticsFilters)=>AnalyticsFilters)=>void;
  apply:()=>void;refresh:()=>void;drill:(projectId:string)=>void;
  data:Data|null;now?:ContextNow|'error'|null;error:string;busy:boolean;platform:boolean;projectLabel?:string;
}) {
  const id=useId();
  const choose=(key:keyof AnalyticsFilters,value:string)=>setFilters(previous=>({...previous,[key]:value}));
  return <section className="usage-analytics" aria-label={platform?'Platform analytics':'Project usage'}>
    {!platform&&<header className="usage-analytics-heading k42-section-heading"><h2 className="k42-section-title">Usage</h2><InfoTip label="Usage">Context and tokens your agents reported, per agent.</InfoTip></header>}
    {platform&&<details className="analytics-filter-details"><summary>Filters · {data?`${data.from} – ${data.to}`:`${filters.from} – ${filters.to}`}</summary><form className="analytics-filters" onSubmit={event=>{event.preventDefault();apply();}}>
      <label htmlFor={`${id}-from`}>From (UTC)<input id={`${id}-from`} type="date" required value={filters.from} onChange={e=>choose('from',e.target.value)}/></label>
      <label htmlFor={`${id}-to`}>To (UTC)<input id={`${id}-to`} type="date" required value={filters.to} onChange={e=>choose('to',e.target.value)}/></label>
      <label htmlFor={`${id}-provider`}>Provider<select id={`${id}-provider`} value={filters.provider} onChange={e=>choose('provider',e.target.value)}><option value="">All providers</option><option value="codex">Codex</option><option value="claude">Claude</option><option value="unknown">Unreported</option></select></label>
      <label htmlFor={`${id}-model`}>Model<input id={`${id}-model`} placeholder="All models" maxLength={150} value={filters.model} onChange={e=>choose('model',e.target.value)}/></label>
      {platform&&<><label htmlFor={`${id}-project`}>Project ID<input id={`${id}-project`} placeholder="All projects" pattern="[a-f0-9]{64}" value={filters.projectId} onChange={e=>choose('projectId',e.target.value)}/></label><label htmlFor={`${id}-group`}>Compare by<select id={`${id}-group`} value={filters.groupBy} onChange={e=>choose('groupBy',e.target.value)}><option value="project">Project</option><option value="model">Provider and model</option></select></label></>}
      <Button type="submit" disabled={busy}>{busy?'Loading…':'Apply filters'}</Button>
    </form></details>}
    {busy&&<p role="status">Loading reported measurements…</p>}
    {error&&<p className="error" role="alert">Could not load analytics. {error} <Button onClick={refresh}>Retry</Button></p>}
    {data&&<>
      {platform&&!data.projectId&&<section className="analytics-project-picker"><h3>Projects</h3><p>Open a project to see its agents and their context timelines.</p><div className="analytics-table-scroll"><table><thead><tr><th scope="col">Project</th><th scope="col">Reported turns</th><th scope="col">Native observations</th><th scope="col">Agents</th></tr></thead><tbody>{data.groups.filter(g=>g.projectId).map(g=><tr key={g.key}><th scope="row">{g.label}</th><td>{g.reports}</td><td>{g.nativeReports}</td><td><Button onClick={()=>drill(g.projectId!)}>View project</Button></td></tr>)}</tbody></table></div>{!data.groups.some(g=>g.projectId)&&<p>{data.groups.length?'Choose Project under Compare by to open an agent timeline.':'No projected reports in this range. Use filters to select a project ID with retained runs.'}</p>}</section>}
      {platform&&data.projectId&&<div className="context-project-scope"><Button onClick={()=>drill('')}>All projects</Button><strong>{projectLabel??`Project ${data.projectId.slice(0,8)}`}</strong></div>}
      {now==='error'?<p className="error" role="alert">Could not load the latest agent turns. <Button onClick={refresh}>Retry</Button></p>:now&&<AgentNow now={now}/>}
      <div className="usage-grid"><TopTools data={data}/><Outcomes data={data}/></div>
    </>}
  </section>;
}

