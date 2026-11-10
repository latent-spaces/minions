import {contextSourceLabels} from './context-source-labels';
import {useId,useState,type CSSProperties} from 'react';
import {PROMPT_SOURCES,type ContextRunPage,type ContextTurnPage} from '@mlswarm/contracts';
import {Button} from './Button';
import {MeasurementPlot} from './MeasurementPlot';
import {pressureStats,requestPressure,suppliedSources} from './context-metrics';
const percent=(value:number|null)=>value===null?'Not reported':`${value.toLocaleString(undefined,{maximumFractionDigits:1})}%`;
const integer=(value:number|null|undefined)=>value==null?'Not reported':value.toLocaleString();
export function ContextTimelineView({runs,selected,turns,busy,error,select,previousRuns,nextRuns,previousTurns,nextTurns,retry}:{runs:ContextRunPage|null;selected:string;turns:ContextTurnPage|null;busy:boolean;error:string;select:(runId:string)=>void;previousRuns?:()=>void;nextRuns?:()=>void;previousTurns?:()=>void;nextTurns?:()=>void;retry:()=>void}){
 const id=useId(),[chosen,setChosen]=useState<number|null>(null),[fullWindow,setFullWindow]=useState(false),[highlight,setHighlight]=useState<{scope:string;label:string}|null>(null);
 const run=runs?.runs.find(r=>r.runId===selected),agents=[...new Map(runs?.runs.map(r=>[r.agentId,r])??[]).values()];
 const turn=turns?.turns.find(t=>t.sequence===chosen)??turns?.turns.at(-1);
 const pressure=requestPressure(turn?.nativeContext),stats=pressureStats(turns?.turns??[]),sources=suppliedSources(turn?.context??null),sourceTotal=sources.reduce((sum,s)=>sum+s.bytes,0);
 const sourceScope=`${selected}:${turn?.sequence}`,activeSource=highlight?.scope===sourceScope?sources.find(source=>source.label===highlight.label):undefined;
 const highlightSource=(label:string)=>setHighlight({scope:sourceScope,label});
 const choose=(runId:string)=>{setChosen(null);select(runId);};
 return <section className="analytics-section analytics-timeline" aria-label="Agent context">
  <div className="context-heading"><div><h3>Context by agent</h3><p>Select an agent to follow its reported request size and supplied context.</p></div><Button onClick={retry} disabled={busy}>Refresh agents</Button></div>
  {error&&<p role="alert">Could not load agent context. {error} <Button onClick={retry}>Retry timeline</Button></p>}
  {runs&&!runs.runs.length&&<p>No runs recorded for this project yet.</p>}
  {runs&&runs.runs.length>0&&<><div className="context-selectors"><label htmlFor={`${id}-agent`}>Agent<select id={`${id}-agent`} value={run?.agentId??''} onChange={e=>{const next=runs.runs.find(r=>r.agentId===e.target.value);if(next)choose(next.runId);}}>{agents.map(a=><option key={a.agentId} value={a.agentId}>{a.agentName??a.agentId}</option>)}</select></label>
   <label htmlFor={`${id}-run`}>Run<select id={`${id}-run`} value={selected} onChange={e=>choose(e.target.value)}>{runs.runs.filter(r=>r.agentId===run?.agentId).map(r=><option key={r.runId} value={r.runId}>{new Date(r.startedAt).toLocaleString()} · {r.endedAt===null?'Open':'Ended'}</option>)}</select></label></div>
   {(previousRuns||nextRuns)&&<div className="analytics-pagination">{previousRuns&&<Button disabled={busy} onClick={previousRuns}>Previous runs</Button>}{nextRuns&&<Button disabled={busy} onClick={nextRuns}>More runs</Button>}<span>Agents from this page of recent runs</span></div>}</>}
  {busy&&<p role="status">Loading agent measurements…</p>}
  {turns&&(!turns.turns.length?<p>No turn reports received for this run.</p>:<>
   <section className="context-pressure" aria-label="Reported request pressure"><div className="context-pressure-title"><h4>Reported request pressure</h4><span>Turn {turn!.sequence} · {turn!.model??turn!.provider}</span></div>
    <div className="context-pressure-number"><strong>{percent(pressure)}</strong>{pressure!==null?<span><b>{integer(turn!.nativeContext!.lastInputTokens)}</b> input tokens<br/><b>{integer(turn!.nativeContext!.modelContextWindow)}</b> reported window</span>:<span>This provider did not report both request input and model-window size.</span>}</div>
    {pressure!==null&&<div className="context-window-gauge" aria-hidden="true"><div className="context-window-track"><span style={{width:`${Math.min(100,pressure)}%`}}/>{[25,50,75].map(tick=><i key={tick} style={{left:`${tick}%`}}/>)}</div><div className="context-window-labels"><span>0%</span><span>50%</span><span>100%</span></div></div>}
    <p>Latest request input ÷ reported window. Retained history and remaining capacity are unknown.</p>
   </section>
   <div className="context-timeline-heading"><h4>Agent timeline</h4><div className="context-chart-scale" role="group" aria-label="Timeline scale"><Button aria-pressed={fullWindow} onClick={()=>setFullWindow(true)}>Full window</Button><Button aria-pressed={!fullWindow} onClick={()=>setFullWindow(false)}>Zoom to reports</Button></div></div>
   <div className="context-timeline-stats"><span><b>{stats.count} / {turns.turns.length}</b> shown turns measured</span>{stats.count>0&&<><span>Median <b>{percent(stats.median)}</b></span><span>Peak <b>{percent(stats.peak)}</b></span></>}</div>
   <MeasurementPlot title="Reported request pressure across turns" unit="% of reported window" axis={fullWindow?'controller turn · full-window scale':'controller turn · zoomed scale'} domainMax={fullWindow?100:undefined} points={turns.turns.map(t=>({label:`Turn ${t.sequence}`,value:requestPressure(t.nativeContext)}))} selectedIndex={turns.turns.findIndex(t=>t.sequence===turn?.sequence)} onSelect={index=>setChosen(turns.turns[index]!.sequence)}/>
   <div className="context-turns" aria-label="Select a turn">{turns.turns.map(t=>{const steering=t.context?.steeringMessages??0,compactions=t.nativeContext?.completedCompactions??0;return <Button key={t.sequence} aria-label={`Turn ${t.sequence}${steering?` · ${steering} steering`:''}${compactions?` · ${compactions} compaction`:''}`} aria-pressed={turn?.sequence===t.sequence} onClick={()=>setChosen(t.sequence)}><span>Turn {t.sequence}</span>{(steering>0||compactions>0)&&<small>{steering>0?'Steered':''}{steering>0&&compactions>0?' · ':''}{compactions>0?'Compacted':''}</small>}</Button>;})}</div>

   <section className="context-sources" aria-label="Selected turn context"><div className="context-timeline-heading"><h4>What MyLittleSwarm supplied · turn {turn!.sequence}</h4><span>{new Date(turn!.endedAt).toLocaleTimeString()} · {turn!.outcome}</span></div>
    <p>Measured prompt and tool traffic across this turn. Shares below refer to supplied bytes, not model tokens.</p>
    {sources.length?<>
     <div className="context-source-visual" onPointerLeave={event=>{if(!event.currentTarget.contains(document.activeElement))setHighlight(null);}} onKeyDown={event=>{if(event.key==='Escape')setHighlight(null);}}>
      {activeSource&&<div role="tooltip" id={`${id}-source-tip`} className="context-source-tooltip"><strong>{activeSource.label}</strong><span>{integer(activeSource.bytes)} bytes · {sourceTotal>0?percent(activeSource.bytes/sourceTotal*100):'No share'} of measured supplied bytes</span></div>}
      <div className="context-source-composition" aria-label="Measured supplied byte composition">{sources.filter(source=>source.bytes>0).map(source=><Button type="button" key={source.label} className="context-source-segment" aria-label={`${source.label}: ${integer(source.bytes)} bytes, ${percent(source.bytes/sourceTotal*100)} of measured supplied bytes`} aria-describedby={activeSource?.label===source.label?`${id}-source-tip`:undefined} data-highlighted={activeSource?.label===source.label} style={{width:`${source.bytes/sourceTotal*100}%`,background:source.color}} onPointerEnter={()=>highlightSource(source.label)} onFocus={()=>highlightSource(source.label)} onBlur={()=>setHighlight(null)} onClick={()=>highlightSource(source.label)}/>)}</div>
     </div>
     <div className="context-source-caption"><span>Hover or focus a segment to identify its source</span><strong>{integer(sourceTotal)} bytes total</strong></div>
     <dl className="context-source-bars">{[...sources].sort((a,b)=>b.bytes-a.bytes).map(source=><div key={source.label} data-highlighted={activeSource?.label===source.label} style={{'--source-color':source.color} as CSSProperties}><dt><span className="context-source-dot" aria-hidden="true"/>{source.label}</dt><dd><span className="context-source-share">{sourceTotal>0?percent(source.bytes/sourceTotal*100):'No share'}</span><strong>{integer(source.bytes)} <small>bytes</small></strong></dd></div>)}</dl>

    </>:<p>Source measurements are unavailable for this turn.</p>}

   </section>
   <details className="context-details"><summary>Measurement details & tools</summary><p>Turn {turn!.sequence} · {new Date(turn!.endedAt).toLocaleString()} · {turn!.provider} / {turn!.model??'Unreported model'} · Session {turn!.context?.sessionMode??'unreported'}. One controller turn can contain several model requests. Charts show only this page of turns.</p>
    {turn!.nativeContext&&<dl className="analytics-outcomes"><div><dt>Latest request input</dt><dd>{integer(turn!.nativeContext.lastInputTokens)} tokens</dd></div><div><dt>Reported model window</dt><dd>{integer(turn!.nativeContext.modelContextWindow)} tokens</dd></div><div><dt>Observed usage updates</dt><dd>{turn!.nativeContext.observations}</dd></div><div><dt>Completed compactions observed</dt><dd>{turn!.nativeContext.completedCompactions}</dd></div></dl>}
    {turn!.context?.promptSources&&<><h4>Prompt construction</h4><dl className="context-exact-sources">{PROMPT_SOURCES.map(key=><div key={key}><dt>{contextSourceLabels[key]}</dt><dd>{integer(turn!.context!.promptSources![key])} bytes</dd></div>)}</dl></>}
    {turn!.context?.byTool&&<div className="analytics-table-scroll"><table><caption>Tools in selected turn</caption><thead><tr><th scope="col">Tool</th><th scope="col">Calls</th><th scope="col">Returned bytes</th><th scope="col">Definition bytes</th><th scope="col">Argument bytes</th><th scope="col">Refusals</th></tr></thead><tbody>{turn!.context.byTool.map(t=><tr key={t.name}><th scope="row">{t.name}</th><td>{t.calls}</td><td>{integer(t.responseTextBytes)}</td><td>{integer(t.definitionBytes)}</td><td>{integer(t.argumentBytes)}</td><td>{t.refusals}</td></tr>)}</tbody></table></div>}
   </details>
  </>)}
  <div className="analytics-pagination">{previousTurns&&<Button disabled={busy} onClick={previousTurns}>Earlier turns</Button>}{nextTurns&&<Button disabled={busy} onClick={nextTurns}>Later turns</Button>}</div>
 </section>;
}
