import {contextSourceLabels as sourceLabels} from './context-source-labels';
import { MeasurementPlot } from './MeasurementPlot';
import { useId, useState, type ReactNode } from 'react';
import { PROMPT_SOURCES } from '@mlswarm/contracts';
import type { AnalyticsMeasure, ContextNow, UsageAnalytics as Data, UsageMetric } from '@mlswarm/contracts';
import { Button } from './Button';
import { AgentNow, Outcomes, SourcesByDay, TopTools } from './UsageOverview';
import './usage-analytics.css';

export type AnalyticsFilters = { from: string; to: string; provider: string; model: string; projectId: string; groupBy: string };
const compact = new Intl.NumberFormat('en', { notation:'compact', maximumFractionDigits:2 });
const exact = new Intl.NumberFormat('en', { maximumFractionDigits:2 });
const labels: Record<UsageMetric,string> = { input:'Input tokens',output:'Output tokens',cacheRead:'Cache-read tokens',cacheWrite:'Cache-write tokens',seconds:'Mean turn duration',toolCalls:'Reported tool calls',steeringBytes:'Steering prompt material',conversationResponseBytes:'Conversation responses',taskResponseBytes:'Task responses',instructionBytes:'Prepared instructions',turnPromptBytes:'Turn prompts',catalogBytes:'Returned tool catalogs',toolResponseBytes:'Returned tool text' };
const tokenMetrics: UsageMetric[] = ['input','output','cacheRead','cacheWrite'];
const contextMetrics: UsageMetric[] = ['steeringBytes','conversationResponseBytes','taskResponseBytes','instructionBytes','turnPromptBytes','catalogBytes','toolResponseBytes'];
const unit = (metric: UsageMetric) => metric.endsWith('Bytes') ? 'bytes' : metric==='seconds' ? 'seconds' : metric==='toolCalls' ? 'calls' : 'tokens';
const number = (measure: AnalyticsMeasure, metric: UsageMetric) => measure.known ? metric==='seconds' ? measure.sum/measure.known : measure.sum : null;
const format = (value: number|null) => value===null ? 'Not measured' : compact.format(value);
function coverage(value: AnalyticsMeasure,reports:number) { return `${value.known.toLocaleString()} of ${reports.toLocaleString()} reports${value.partial ? ' · partial source' : ''}`; }

export function UsageAnalyticsView({filters,setFilters,apply,refresh,drill,data,now,error,busy,platform,timeline,projectLabel}: {
  filters:AnalyticsFilters;setFilters:(update:(previous:AnalyticsFilters)=>AnalyticsFilters)=>void;
  apply:()=>void;refresh:()=>void;drill:(projectId:string)=>void;
  data:Data|null;now?:ContextNow|'error'|null;error:string;busy:boolean;platform:boolean;timeline?:ReactNode;projectLabel?:string;
}) {
  const [metric,setMetric]=useState<UsageMetric>('input'); const id=useId();
  const choose=(key:keyof AnalyticsFilters,value:string)=>setFilters(previous=>({...previous,[key]:value}));
  return <section className="usage-analytics" aria-label={platform?'Platform analytics':'Project usage'}>
    <details className="analytics-filter-details"><summary>Filters · {data?`${data.from} – ${data.to}`:`${filters.from} – ${filters.to}`}</summary><form className="analytics-filters" onSubmit={event=>{event.preventDefault();apply();}}>
      <label htmlFor={`${id}-from`}>From (UTC)<input id={`${id}-from`} type="date" required value={filters.from} onChange={e=>choose('from',e.target.value)}/></label>
      <label htmlFor={`${id}-to`}>To (UTC)<input id={`${id}-to`} type="date" required value={filters.to} onChange={e=>choose('to',e.target.value)}/></label>
      <label htmlFor={`${id}-provider`}>Provider<select id={`${id}-provider`} value={filters.provider} onChange={e=>choose('provider',e.target.value)}><option value="">All providers</option><option value="codex">Codex</option><option value="claude">Claude</option><option value="unknown">Unreported</option></select></label>
      <label htmlFor={`${id}-model`}>Model<input id={`${id}-model`} placeholder="All models" maxLength={150} value={filters.model} onChange={e=>choose('model',e.target.value)}/></label>
      {platform&&<><label htmlFor={`${id}-project`}>Project ID<input id={`${id}-project`} placeholder="All projects" pattern="[a-f0-9]{64}" value={filters.projectId} onChange={e=>choose('projectId',e.target.value)}/></label><label htmlFor={`${id}-group`}>Compare by<select id={`${id}-group`} value={filters.groupBy} onChange={e=>choose('groupBy',e.target.value)}><option value="project">Project</option><option value="model">Provider and model</option></select></label></>}
      <Button type="submit" disabled={busy}>{busy?'Loading…':'Apply filters'}</Button>
    </form></details>
    {busy&&<p role="status">Loading reported measurements…</p>}
    {error&&<p className="error" role="alert">Could not load analytics. {error} <Button onClick={refresh}>Retry</Button></p>}
    {data&&<>
      {platform&&!data.projectId&&<section className="analytics-project-picker"><h3>Projects</h3><p>Open a project to see its agents and their context timelines.</p><div className="analytics-table-scroll"><table><thead><tr><th scope="col">Project</th><th scope="col">Reported turns</th><th scope="col">Native observations</th><th scope="col">Agents</th></tr></thead><tbody>{data.groups.filter(g=>g.projectId).map(g=><tr key={g.key}><th scope="row">{g.label}</th><td>{g.reports}</td><td>{g.nativeReports}</td><td><Button onClick={()=>drill(g.projectId!)}>View project</Button></td></tr>)}</tbody></table></div>{!data.groups.some(g=>g.projectId)&&<p>{data.groups.length?'Choose Project under Compare by to open an agent timeline.':'No projected reports in this range. Use filters to select a project ID with retained runs.'}</p>}</section>}
      {platform&&data.projectId&&<div className="context-project-scope"><Button onClick={()=>drill('')}>All projects</Button><strong>{projectLabel??`Project ${data.projectId.slice(0,8)}`}</strong></div>}
      {now==='error'?<p className="error" role="alert">Could not load the latest agent turns. <Button onClick={refresh}>Retry</Button></p>:now&&<AgentNow now={now}/>}
      <div className="usage-grid"><TopTools data={data}/><Outcomes data={data}/></div>
      <SourcesByDay data={data}/>
      {timeline}
      <details className="analytics-project-details"><summary>Exact values & coverage</summary>
      <div className="analytics-coverage"><strong>{data.totals.reports.toLocaleString()} projected turn reports</strong><span>{data.from} – {data.to} · UTC completion days</span><span>{data.pendingReports}{data.pendingReportsCapped?'+':''} pending reports in this scope, across all dates</span><span>Historical coverage not verified. Offline computers may have unreported work.</span><span>{data.lastProjectedAt===null?'No projection in this range':`Latest bucket update: ${new Date(data.lastProjectedAt).toLocaleString()}`}</span></div>
      <SourceOverhead data={data} drill={platform?drill:undefined}/>
      {!data.totals.reports?<p className="analytics-empty">No projected reports in this range. Try another date range or refresh after reporting finishes. Older history may need backfilling.</p>:<>
        <details className="analytics-context"><summary>Provider token usage and turn outcomes</summary><div className="analytics-metric-choice"><label htmlFor={`${id}-metric`}>Plot measurement</label><select id={`${id}-metric`} value={metric} onChange={e=>setMetric(e.target.value as UsageMetric)}>{[...tokenMetrics,'seconds','toolCalls'].map(key=><option key={key} value={key}>{labels[key as UsageMetric]}</option>)}</select><span>{coverage(data.totals.metrics[metric],data.totals.reports)}</span></div>
        {platform&&<Comparison data={data} metric={metric} drill={drill}/>}
        <DailyPlot data={data} metric={metric}/>
        {!platform&&<Comparison data={data} metric={metric}/>}
        <section className="analytics-section"><h3>Reported turn outcomes</h3><p>Attempt outcomes, independent of task completion or work quality.</p><dl className="analytics-outcomes">{Object.entries(data.totals.outcomes).map(([key,value])=><div key={key}><dt>{({succeeded:'Succeeded',failed:'Failed',timed_out:'Timed out',budget_cap:'Budget cap'})[key]}</dt><dd>{value.toLocaleString()}</dd></div>)}<div><dt>Mean turn duration</dt><dd>{format(number(data.totals.metrics.seconds,'seconds'))} s</dd></div></dl><p>Turn durations can overlap across agents; their sum is not project elapsed time.</p></section>
        </details>
      </>}
      </details>
    </>}
  </section>;
}

function SourceOverhead({data,drill}:{data:Data;drill?:(id:string)=>void}) {
  const [metric,setMetric]=useState<UsageMetric>('conversationResponseBytes');const id=useId();
  return <section className="analytics-section analytics-overhead"><h3>MyLittleSwarm context sources</h3><p>Material supplied by MyLittleSwarm in this selection. These measured UTF-8 sizes explain additions, not how much history the native client currently retains. These project reports do not include a matched direct-model baseline.</p><p>{data.totals.nativeReports} of {data.totals.reports} reports include native scalar observations. Largest reported last-input snapshot: {data.totals.nativeLastInputMax===null?'Unknown':`${data.totals.nativeLastInputMax.toLocaleString()} tokens`}. Completed compactions observed: {data.totals.nativeReports?data.totals.nativeCompactions:'Unknown'}. These do not establish retained context size.</p>
    <label htmlFor={id}>Context source over time</label><select id={id} value={metric} onChange={e=>setMetric(e.target.value as UsageMetric)}>{contextMetrics.map(key=><option key={key} value={key}>{labels[key]}</option>)}</select><DailyPlot data={data} metric={metric}/>{drill&&<Comparison data={data} metric={metric} drill={drill}/>}
    <dl className="analytics-outcomes">{(['instructionBytes','turnPromptBytes','catalogBytes','toolResponseBytes'] as const).map(key=><div key={key}><dt>{labels[key]}</dt><dd>{format(number(data.totals.metrics[key],key))}{data.totals.metrics[key].known?' bytes':''}</dd><small>{coverage(data.totals.metrics[key],data.totals.reports)}</small></div>)}</dl>
    <h4>Assembled prompt sources</h4><p>{data.totals.promptSourceReports} of {data.totals.reports} reports include source attribution. Instructions and returned tools are measured separately below.</p>
    {data.totals.promptSourceReports?<div className="analytics-table-scroll"><table><thead><tr><th scope="col">Prompt source</th><th scope="col">UTF-8 bytes supplied</th></tr></thead><tbody>{PROMPT_SOURCES.map(key=><tr key={key}><th scope="row">{sourceLabels[key]}</th><td>{exact.format(data.totals.promptSources[key])}</td></tr>)}</tbody></table></div>:<p>Prompt-source attribution was not measured in these reports. Updated workers report it on subsequent turns.</p>}
    <details><summary>Each MCP tool: definitions and returned material</summary><p>{data.totals.mcpReports} of {data.totals.reports} reports include individual tool counters. Definition bytes count each catalog delivery; calls and returned text describe the facade boundary. Array/envelope overhead is excluded from individual definitions.</p>
    {data.totals.mcpReports?<div className="analytics-table-scroll"><table><thead><tr><th scope="col">Tool</th><th scope="col">Definition bytes</th><th scope="col">Catalog deliveries</th><th scope="col">Calls</th><th scope="col">Argument bytes</th><th scope="col">Returned text bytes</th><th scope="col">Refusals</th></tr></thead><tbody>{Object.entries(data.totals.mcpTools).sort(([a],[b])=>a.localeCompare(b)).map(([name,t])=><tr key={name}><th scope="row">{name}</th><td>{exact.format(t!.definitionBytes)}</td><td>{t!.catalogDeliveries}</td><td>{t!.calls}</td><td>{exact.format(t!.argumentBytes)}</td><td>{exact.format(t!.responseTextBytes)}</td><td>{t!.refusals}</td></tr>)}</tbody></table></div>:<p>Individual tool sizes are unavailable in these reports.</p>}</details>
  </section>;
}
function DailyPlot({data,metric}:{data:Data;metric:UsageMetric}) {
  return <section className="analytics-section"><h3>{labels[metric]} by day</h3><MeasurementPlot title={`${labels[metric]} by UTC completion day`} unit={unit(metric)} axis="UTC completion days" points={data.points.map(point=>({label:point.day,value:number(point.metrics[metric],metric)}))}/>
    <details className="analytics-values"><summary>Daily values and coverage</summary><div className="analytics-table-scroll"><table><thead><tr><th scope="col">UTC day</th><th scope="col">{labels[metric]} ({unit(metric)})</th><th scope="col">Coverage</th></tr></thead><tbody>{data.points.map(point=><tr key={point.day}><th scope="row">{point.day}</th><td>{point.metrics[metric].known?exact.format(number(point.metrics[metric],metric)!):'Not measured'}</td><td>{coverage(point.metrics[metric],point.reports)}</td></tr>)}</tbody></table></div></details>
  </section>;
}
function Comparison({data,metric,drill}:{data:Data;metric:UsageMetric;drill?:(id:string)=>void}) {
  const rows=[...data.groups].sort((a,b)=>(number(b.metrics[metric],metric)??-1)-(number(a.metrics[metric],metric)??-1));
  const max=Math.max(1,...rows.map(row=>number(row.metrics[metric],metric)??0));
  return <section className="analytics-section"><h3>{drill?'Compare projects or models':'Usage by provider and model'}</h3><p>{labels[metric]} · {unit(metric)}</p><div className="analytics-table-scroll"><table><thead><tr><th scope="col">{drill?'Project / model':'Provider / model'}</th><th scope="col">{labels[metric]}</th><th scope="col">Coverage</th>{drill&&<th scope="col">Scope</th>}</tr></thead><tbody>{rows.map(row=><tr key={row.key}><th scope="row" title={row.projectId??row.label}>{row.label}</th><td><span className="analytics-bar" aria-hidden="true"><span style={{width:`${(number(row.metrics[metric],metric)??0)/max*100}%`}}/></span>{format(number(row.metrics[metric],metric))}</td><td>{coverage(row.metrics[metric],row.reports)}</td>{drill&&<td>{row.projectId&&<Button onClick={()=>drill(row.projectId!)}>View project</Button>}</td>}</tr>)}</tbody></table></div></section>;
}
