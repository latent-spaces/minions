import { useEffect, useId, useRef, useState } from 'react';
const compact=new Intl.NumberFormat('en',{notation:'compact',maximumFractionDigits:2});
export function MeasurementPlot({title,unit,points,axis,domainMax,selectedIndex,onSelect}:{title:string;unit:string;points:{label:string;value:number|null}[];axis:string;domainMax?:number;selectedIndex?:number;onSelect?:(index:number)=>void}){
 const id=useId(),known=points.filter(p=>p.value!==null),max=Math.max(domainMax??1,...known.map(p=>p.value!));
 const ref=useRef<HTMLElement>(null),[width,setWidth]=useState(760),hasKnown=known.length>0;
 useEffect(()=>{
  const element=ref.current;if(!element)return;
  const update=()=>setWidth(Math.max(240,Math.round(element.getBoundingClientRect().width)));update();
  if(typeof ResizeObserver!=='undefined'){const observer=new ResizeObserver(update);observer.observe(element);return()=>observer.disconnect();}
  window.addEventListener('resize',update);return()=>window.removeEventListener('resize',update);
 },[hasKnown]);
 const height=230,left=64,right=16,top=16,bottom=42;
 const x=(i:number)=>points.length===1?(left+width-right)/2:left+i*(width-left-right)/Math.max(1,points.length-1),y=(v:number)=>height-bottom-v/max*(height-top-bottom);
 let path='',connected=false;points.forEach((p,i)=>{if(p.value===null){connected=false;return;}path+=`${connected?'L':'M'}${x(i)},${y(p.value)} `;connected=true;});
 if(!known.length)return <p>Not measured in these reports.</p>;
 return <figure ref={ref} className="analytics-chart"><svg viewBox={`0 0 ${width} ${height}`} role={onSelect?'group':'img'} aria-labelledby={id}><title id={id}>{title}. Missing measurements remain gaps; numeric values follow.</title>{[0,.5,1].map(r=><g key={r}><line x1={left} x2={width-right} y1={y(r*max)} y2={y(r*max)} className="analytics-grid"/><text x={left-8} y={y(r*max)+4} textAnchor="end">{compact.format(r*max)}</text></g>)}<path d={path} fill="none" className="analytics-line"/>{points.map((p,i)=>p.value===null?null:<circle key={p.label} cx={x(i)} cy={y(p.value)} r={selectedIndex===i?5:3} className="analytics-dot" role={onSelect?'button':undefined} tabIndex={onSelect?0:undefined} aria-label={onSelect?`${p.label}: ${p.value.toLocaleString()} ${unit}`:undefined} aria-pressed={onSelect?selectedIndex===i:undefined} onClick={onSelect?()=>onSelect(i):undefined} onKeyDown={onSelect?event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();onSelect(i);}}:undefined}><title>{p.label}: {p.value.toLocaleString()} {unit}</title></circle>)}<text x={points.length===1?x(0):left} textAnchor={points.length===1?'middle':'start'} y={height-14}>{points[0]?.label}</text>{points.length>1&&<text x={width-right} y={height-14} textAnchor="end">{points.at(-1)?.label}</text>}</svg><figcaption>{unit} · {axis} · missing measurements remain gaps</figcaption></figure>;
}
