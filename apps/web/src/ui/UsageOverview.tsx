import {useRef,useState,type CSSProperties,type FocusEvent,type PointerEvent,type ReactNode} from 'react';
import type {ContextNow,UsageAnalytics as Data} from '@mlswarm/contracts';
import {Button} from './Button';
import {SOURCES,isSetupSource,requestPressure,suppliedSources,type Source} from './context-metrics';

type Tip={x:number;y:number;title:string;lines:string[]};
const number=new Intl.NumberFormat('en',{maximumFractionDigits:1});
export const kb=(bytes:number)=>bytes>=1e6?`${number.format(bytes/1e6)} MB`:`${number.format(bytes/1e3)} KB`;
const share=(part:number,total:number)=>total>0?`${Math.round(part/total*100)}%`:'';

// A card whose marks show a dark tooltip on hover or keyboard focus; Escape or leaving the card hides it.
// The tooltip stays inside the card: its centre keeps half the 260px maximum width from either edge.
function Card({title,aside,children,className}:{title:string;aside?:ReactNode;children:(show:(tip:Omit<Tip,'x'|'y'>)=>{onPointerEnter:(e:PointerEvent<Element>)=>void;onFocus:(e:FocusEvent<Element>)=>void})=>ReactNode;className?:string}){
 const ref=useRef<HTMLElement>(null),[tip,setTip]=useState<Tip|null>(null);
 const place=(target:Element,next:Omit<Tip,'x'|'y'>)=>{const box=target.getBoundingClientRect(),card=ref.current!.getBoundingClientRect();const edge=Math.min(130,card.width/2);setTip({...next,x:Math.min(card.width-edge,Math.max(edge,box.left+box.width/2-card.left)),y:box.top-card.top});};
 const show=(next:Omit<Tip,'x'|'y'>)=>({onPointerEnter:(e:PointerEvent<Element>)=>place(e.currentTarget,next),onFocus:(e:FocusEvent<Element>)=>place(e.currentTarget,next)});
 return <section ref={ref} className={`usage-card ${className??''}`} onPointerLeave={()=>setTip(null)} onBlur={e=>{if(!e.currentTarget.contains(e.relatedTarget))setTip(null);}} onKeyDown={e=>{if(e.key==='Escape')setTip(null);}}>
  <header><h3>{title}</h3>{aside}</header>{children(show)}
  {tip&&<div role="tooltip" className="usage-tip" style={{left:tip.x,top:tip.y}}><strong>{tip.title}</strong>{tip.lines.map(line=><span key={line}>{line}</span>)}</div>}
 </section>;
}
const Legend=({sources}:{sources:readonly Source[]})=><ul className="usage-legend">{sources.map(s=><li key={s.key} data-setup={isSetupSource(s.key)||undefined} style={{'--swatch':s.color} as CSSProperties}>{s.label}</li>)}</ul>;
const tokens=new Intl.NumberFormat('en',{notation:'compact',maximumFractionDigits:1});

function Ring({value}:{value:number|null}){
 if(value===null)return <span className="usage-ring">–</span>;
 const r=13,length=2*Math.PI*r;
 return <span className="usage-ring"><svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r={r}/><circle cx="16" cy="16" r={r} strokeDasharray={`${Math.min(100,value)/100*length} ${length}`}/></svg><b>{Math.round(value)}%</b></span>;
}
function Spark({values}:{values:(number|null)[]}){
 if(!values.some(v=>v!==null))return <span className="usage-spark"/>;
 const x=(i:number)=>values.length===1?32:i*64/(values.length-1),y=(v:number)=>22-Math.min(100,v)/100*20;
 let path='',open=false;values.forEach((v,i)=>{if(v===null){open=false;return;}path+=`${open?'L':'M'}${x(i)},${y(v)} `;open=true;});
 return <svg className="usage-spark" viewBox="0 0 64 24" aria-hidden="true"><path d={path}/></svg>;
}

/** Latest measured turn of each agent: what MyLittleSwarm supplied (bytes) beside request pressure (tokens), never stacked together. */
export function AgentNow({now}:{now:ContextNow}){
 const rows=now.agents.map(agent=>{
  const latest=[...agent.turns].reverse().find(t=>t.context),sources=suppliedSources(latest?.context??null);
  const pressures=agent.turns.map(t=>requestPressure(t.nativeContext));
  const native=agent.turns.findLast(t=>requestPressure(t.nativeContext)!==null)?.nativeContext??null;
  return {agent,latest,sources,total:sources.reduce((n,s)=>n+s.bytes,0),pressure:pressures.findLast(v=>v!==null)??null,pressures,window:native?.modelContextWindow??null,input:native?.lastInputTokens??null};
 });
 const max=Math.max(1,...rows.map(r=>r.total)),used=SOURCES.filter(s=>rows.some(r=>r.sources.some(x=>x.key===s.key&&x.bytes>0)));
 return <Card title="Now · latest turn per agent" className="usage-now" aside={<span className="usage-aside">Supplied context · share of the context window</span>}>{show=><>
  {!rows.length?<p className="usage-empty">No agent turns reported yet.</p>:<>
   <Legend sources={used}/>
   {/* Hatched marks are MyLittleSwarm setup, as in Karma42 (owner, 11 November 2026). */}
   {used.some(s=>isSetupSource(s.key))&&<p className="usage-pattern-key"><span aria-hidden="true" data-setup="true"/>Hatched: MyLittleSwarm setup, the same every turn.</p>}
   <div className="usage-now-row usage-now-column-labels" aria-hidden="true"><span>Agent</span><span>Supplied context</span><span>Size</span><span>Window</span><span>Trend</span></div>
   <div className="usage-now-rows">{rows.map(({agent,latest,sources,total,pressure,pressures,window,input})=>{const name=agent.agentName??'Agent';return <div key={agent.agentId} className="usage-now-row">
    <span className="usage-now-name">{name}</span>
    <div className="usage-stack" style={{width:`${total/max*100}%`}}>{latest?sources.filter(s=>s.bytes>0).map(s=><Button key={s.key} type="button" className="usage-seg" data-setup={isSetupSource(s.key)||undefined} style={{flexGrow:s.bytes,backgroundColor:s.color}}
      aria-label={`${name} · ${s.label}: ${kb(s.bytes)}, ${share(s.bytes,total)}`} {...show({title:`${name} · ${s.label}`,lines:[`${kb(s.bytes)} · ${share(s.bytes,total)}`,...(isSetupSource(s.key)?['Hatched · MyLittleSwarm setup']:[]),`Turn ${latest.sequence}`]})}/>):<span className="usage-none">Not measured</span>}</div>
    <span className="usage-total">{latest?kb(total):''}</span><span className="usage-window" title={window!==null&&input!==null?`${input.toLocaleString()} input tokens of a ${window.toLocaleString()}-token context window`:'The agent did not report its context window'}><Ring value={pressure}/><small>{window!==null?`of ${tokens.format(window)}`:'Not reported'}</small></span><Spark values={pressures}/>
   </div>;})}</div>
  </>}
 </>}</Card>;
}

export function TopTools({data}:{data:Data}){
 const tools=Object.entries(data.totals.mcpTools).map(([name,t])=>({name,...t!})).sort((a,b)=>b.responseTextBytes-a.responseTextBytes).slice(0,6),max=Math.max(1,...tools.map(t=>t.responseTextBytes));
 return <Card title="Top tools" aside={<span className="usage-aside">Returned text</span>}>{show=>!tools.length?<p className="usage-empty">No tool measurements.</p>:<div className="usage-bars">{tools.map(t=><div key={t.name} className="usage-bar-row">
  <span>{t.name}</span><span className="usage-bar-track"><Button type="button" className="usage-bar" style={{width:`${t.responseTextBytes/max*100}%`}} aria-label={`${t.name}: ${kb(t.responseTextBytes)} returned, ${t.calls} calls`}
   {...show({title:t.name,lines:[`${kb(t.responseTextBytes)} returned`,`${t.calls.toLocaleString()} calls · ${kb(t.definitionBytes)} definitions`]})}/></span><b>{kb(t.responseTextBytes)}</b>
 </div>)}</div>}</Card>;
}

const outcomes=[{key:'succeeded',label:'Succeeded',color:'var(--status-good)'},{key:'failed',label:'Failed',color:'var(--status-critical)'},{key:'timed_out',label:'Timed out',color:'var(--status-serious)'},{key:'budget_cap',label:'Budget cap',color:'var(--status-warning)'}] as const;
export function Outcomes({data}:{data:Data}){
 const total=data.totals.reports,r=40,length=2*Math.PI*r;let start=0;
 const arcs=outcomes.map(o=>{const value=data.totals.outcomes[o.key],arc=total>0?value/total*length:0;start+=arc;return {...o,value,arc,start:start-arc};});
 return <Card title="Turn outcomes">{show=><div className="usage-donut">
  <svg viewBox="0 0 100 100" role="img" aria-label={outcomes.map(o=>`${o.label} ${data.totals.outcomes[o.key]}`).join(', ')}><circle className="usage-donut-track" cx="50" cy="50" r={r}/>
   {arcs.filter(o=>o.value>0).map(o=><circle key={o.key} cx="50" cy="50" r={r} stroke={o.color} strokeDasharray={`${Math.max(0,o.arc-1.5)} ${length}`} strokeDashoffset={-o.start} tabIndex={0} {...show({title:o.label,lines:[`${o.value.toLocaleString()} turns · ${share(o.value,total)}`]})}/>)}
  </svg>
  <div className="usage-donut-center"><b>{total.toLocaleString()}</b><span>turns</span></div>
  <ul className="usage-legend usage-legend-column">{outcomes.map(o=><li key={o.key} style={{'--swatch':o.color} as CSSProperties}>{o.label}<b>{data.totals.outcomes[o.key].toLocaleString()}</b></li>)}</ul>
 </div>}</Card>;
}
