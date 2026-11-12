import { PersonMapNode } from './PersonMapNode';
import {EdgeAppearance} from './edge-appearance';
import {ownerColor} from './owner-colors';
import {worldGrid} from './grid';
import type {CSSProperties,ReactNode} from 'react';
import {MessageFlights} from './message-flights';
import {projectPoints,fitReadableCamera,expandReadableCamera,screenPoint} from './projection';
import {initialPositions3D} from './layout3d';
import {useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import type {CommunicationAgent} from '@mlswarm/contracts';
import {CommunicationAgentNode} from '../CommunicationAgentNode';
import {communicationWeights,initialPositions,EDGE_MIN_WEIGHT,type Traffic} from './layout';
import {metadataTraffic,type MapNode,type MapReply,type MapRequest} from './protocol';
import {createPortal} from 'react-dom';
import './map.css';

/** How a crowded overview draws agents. Home uses the default, `portraits`. */
export type Crowding='portraits'|'shrink'|'dots'|'focus-active'|'focus-ring';
const focusMode=(mode:Crowding)=>mode==='focus-active'||mode==='focus-ring';
type Props={crowding?:Crowding;simulatedStates?:boolean;initialDimensions?:2|3;controlsSlot?:HTMLElement|null;toolbarStart?:ReactNode;nodes:MapNode[];traffic:Traffic[];at:number;running:boolean;speed:number;active:boolean;replay:boolean;now:number;
 observations:Map<string,CommunicationAgent>;selected:string|null;inspected:string|null;tooltipId:string;
 onInspect:(id:string,anchor:SVGGElement,pin:boolean)=>void;onLeave:()=>void;onDismiss:()=>void;
 onSelect:(id:string|null)=>void;onEdge:(from:string,to:string)=>void};
/** Share of points with another point closer than one portrait (44px). */
function overlapShare(screen:{x:number;y:number}[]){
 const cells=new Map<string,number[]>(),cell=44;let overlapping=0;
 for(const [i,p] of screen.entries()){const k=Math.floor(p.x/cell)+':'+Math.floor(p.y/cell),list=cells.get(k);if(list)list.push(i);else cells.set(k,[i]);}
 for(const [i,p] of screen.entries()){const cx=Math.floor(p.x/cell),cy=Math.floor(p.y/cell);search:for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)for(const j of cells.get((cx+dx)+':'+(cy+dy))??[])if(j!==i&&Math.hypot(screen[j].x-p.x,screen[j].y-p.y)<cell){overlapping++;break search;}}
 return overlapping/Math.max(1,screen.length);
}
/** Presentation has no auth, polling, model control, data fetching or lab settings. */
export function CommunicationMap(props:Props){
 const controlsRef=useRef<HTMLDivElement>(null);
 const root=useRef<HTMLDivElement>(null),svg=useRef<SVGSVGElement>(null),canvas=useRef<HTMLCanvasElement>(null);
 const dimensions=props.initialDimensions??2,[zoom,setZoom]=useState(1),[failure,setFailure]=useState(''),[retry,setRetry]=useState(0);
 useEffect(()=>{
  const element=root.current;if(!element)return;let inView=true;
  const update=()=>{element.dataset.stateMotion=String(props.running&&props.active&&inView&&!document.hidden);};
  const observer=new IntersectionObserver(([entry])=>{inView=entry.isIntersecting;update();});observer.observe(element);
  document.addEventListener('visibilitychange',update);update();
  return()=>{observer.disconnect();document.removeEventListener('visibilitychange',update);};
 },[props.running,props.active]);
 const ownerGroups=useMemo(()=>{const groups=new Map<string,{id:string;name:string;count:number;mine:boolean}>();for(const node of props.nodes){if(!node.ownerId||node.personId)continue;const found=groups.get(node.ownerId);if(found){found.count++;found.mine ||= !!props.observations.get(node.id)?.mine;if(node.ownerName)found.name=node.ownerName;}else groups.set(node.ownerId,{id:node.ownerId,name:node.ownerName??'',count:1,mine:!!props.observations.get(node.id)?.mine});}return [...groups.values()].sort((a,b)=>a.id.localeCompare(b.id)).map(group=>({...group,name:group.name||(group.mine?'You':'Removed person')}));},[props.nodes,props.observations]);
 const ownerLabels=new Map(ownerGroups.map(group=>[group.id,group.name]));
 const highlightedOwner=props.nodes.find(node=>node.id===(props.inspected??props.selected))?.ownerId||'';
 const crowded=props.nodes.length>24;
 const fitting=useRef(true),orbit=useRef({yaw:.55,pitch:-.35});
 const control=useRef({...props,zoom,dimensions,highlightedOwner,received:performance.now()});
 useLayoutEffect(()=>{control.current={...props,zoom,dimensions,highlightedOwner,received:performance.now()};});
 const peopleRing=props.crowding==='focus-ring',showAll=useRef(false),outsideRef=useRef<HTMLParagraphElement>(null);
 const key=JSON.stringify([dimensions,peopleRing,props.nodes.map(n=>[n.id,n.ownerId??null])]);
 const positions=useMemo(()=>{const seed=dimensions===3?initialPositions3D(props.nodes.length):initialPositions(props.nodes.length);return props.nodes.map((n,i)=>({...n,x:seed[i*dimensions],y:seed[i*dimensions+1]}));},[key]);
 const visibleNodes=positions.map((n,i)=>({...n,...props.nodes[i]}));
 const edgePool=useMemo(()=>{const links=new Map<string,{from:string;to:string}>();for(const m of props.traffic)if(m.audience==='direct')for(const to of m.to)if(to!==m.agentId)links.set(JSON.stringify([m.agentId,to]),{from:m.agentId,to});return [...links.values()];},[props.traffic]);
 const home=()=>{fitting.current=true;showAll.current=false;setZoom(1);root.current?.dispatchEvent(new Event('map-fit'));};
 const zoomBy=(factor:number)=>{fitting.current=false;setZoom(z=>Math.max(.5,Math.min(12,z*factor)));};
 useEffect(()=>{
  const dismiss=(event:Event)=>{const target=event.target as Element|null;if(target?.closest?.('.k42-communication-agent-tooltip'))return;if(event instanceof KeyboardEvent){if(['Shift','Control','Alt','Meta'].includes(event.key))return;if(target?.closest?.('.k42-communication-agent')&&['Enter',' '].includes(event.key))return;}control.current.onDismiss();};
  document.addEventListener('keydown',dismiss);document.addEventListener('wheel',dismiss,{passive:true});
  return()=>{document.removeEventListener('keydown',dismiss);document.removeEventListener('wheel',dismiss);};
 },[]);
 useEffect(()=>{
  const element=root.current!;element.dataset.mapFrames='0';element.dataset.mapRenderedDimensions='';
  const drawing=canvas.current!.getContext('2d'),vector=svg.current!;if(!drawing){setFailure('Canvas unavailable');return;}
  let worker:Worker;try{worker=new Worker(new URL('./map.worker.ts',import.meta.url),{type:'module'});}catch(error){setFailure(error instanceof Error?error.message:'Layout worker unavailable');return;}
  let display:Float64Array=dimensions===3?initialPositions3D(positions.length):initialPositions(positions.length),target:Float64Array=display.slice(),ready=false,pending=false,sequence=0,accepted=0,raf=0,lastStep=-Infinity,lastDraw=0,dirty=true,needsStep=true;
  const flights=new MessageFlights(),edgeAppearance=new EdgeAppearance();let animationClock=0,floorY=0,gridRadius=1000;
  let dense=false,crowdedOverview=false,shrink=1,outside=-1;const featuredUntil=new Float64Array(positions.length),displayScale=new Float64Array(positions.length).fill(1);
  let world=440,overviewSpan=440,camera={x:0,y:0},fitPending=true,viewportDirty=true,box={width:0,height:0},topInset=0,lastViewBox='',depthOrder:number[]=[];const reduced=matchMedia('(prefers-reduced-motion: reduce)'),index=new Map(positions.map((n,i)=>[n.id,i]));
  const nodeElements=positions.map(n=>element.querySelector('[data-map-id="'+CSS.escape(n.id)+'"] .k42-communication-agent'));
  const post=(data:MapRequest)=>worker.postMessage(data);
  const fail=(message:string)=>{setFailure(message);ready=false;};setFailure('');
  worker.onmessage=({data}:{data:MapReply})=>{
   if(data.kind==='error'){fail(data.message);return;}
   if(data.kind==='seed'){floorY=0;gridRadius=1000;for(let i=0;i<data.points.length;i+=dimensions){floorY=Math.max(floorY,data.points[i+1]+200);for(let d=0;d<dimensions;d++)gridRadius=Math.max(gridRadius,Math.abs(data.points[i+d])*1.4);}display=data.points;target=display.slice();ready=true;fitPending=true;dirty=true;return;}
   pending=false;if(data.sequence!==accepted)return;target=data.points;if(control.current.running&&reduced.matches)display=target.slice();dirty=true;
  };
  worker.onerror=e=>{e.preventDefault();fail(e.message||'Layout worker unavailable');};
  post({kind:'init',dimensions,peopleRing,nodes:props.nodes.map(({id,ownerId,personId})=>({id,ownerId,person:!!personId})),traffic:metadataTraffic(props.traffic)});
  const invalidate=()=>{accepted=++sequence;dirty=true;needsStep=true;};element.addEventListener('map-frame',invalidate);
  const updateTraffic=(event:Event)=>{post({kind:'traffic',traffic:metadataTraffic((event as CustomEvent<Traffic[]>).detail)});invalidate();};element.addEventListener('map-traffic',updateTraffic);
  const fit=()=>{fitPending=true;dirty=true;};element.addEventListener('map-fit',fit);
  const resize=new ResizeObserver(()=>{viewportDirty=true;if(fitting.current)fitPending=true;dirty=true;});resize.observe(element);if(controlsRef.current&&element.contains(controlsRef.current))resize.observe(controlsRef.current);
  const paint=(time:number)=>{
   raf=requestAnimationFrame(paint);const c=control.current,dt=Math.min(50,Math.max(0,time-lastDraw));
   if(!ready||!c.active||document.hidden)return;
   const at=c.at+(c.running?Math.min(1000,Math.max(0,time-c.received))*(c.replay?c.speed:1):0);
   if(!pending&&(needsStep||c.running&&time-lastStep>=100)){pending=true;needsStep=false;accepted=++sequence;post({kind:'step',sequence,at,elapsedMs:c.running?(Number.isFinite(lastStep)?Math.min(200,time-lastStep):100):0});lastStep=time;}
   if(!c.running&&!dirty)return;if(time-lastDraw<1000/30)return;lastDraw=time;dirty=false;
   if(c.running){
    animationClock+=dt;
    // The worker owns all collision forces. Projecting displayed positions apart
    // here used to undo interpolation and create tiny jumps on every frame.
    const blend=1-Math.exp(-dt/120);
    for(let i=0;i<display.length;i++)display[i]=reduced.matches?target[i]:display[i]+(target[i]-display[i])*blend;
   }
   const projected=projectPoints(display,dimensions,orbit.current.yaw,orbit.current.pitch);
   if(viewportDirty){const rect=element.getBoundingClientRect();box={width:rect.width,height:rect.height};const inside=controlsRef.current&&element.contains(controlsRef.current);topInset=inside?controlsRef.current!.getBoundingClientRect().bottom-rect.top+12:0;viewportDirty=false;}
   if(box.width<=0||box.height<=0)return;
   const weights=new Map(communicationWeights(c.traffic,at).map(e=>[JSON.stringify([e.from,e.to]),e]));
   const mode=c.crowding??'portraits',featured=new Uint8Array(positions.length);
   if(mode!=='portraits'){
    // Talking agents stay featured for four seconds after their connection
    // fades, so short exchanges do not flicker between dot and portrait.
    for(const link of weights.values())if(link.weight>=EDGE_MIN_WEIGHT)for(const id of [link.from,link.to]){const i=index.get(id);if(i!==undefined)featuredUntil[i]=at+4000;}
    for(const [i,n] of positions.entries())if(at<featuredUntil[i]&&featuredUntil[i]-at<=4000||n.id===c.inspected||n.id===c.selected||c.highlightedOwner&&n.ownerId===c.highlightedOwner)featured[i]=1;
   }
   // Fit to the agents in live conversations when that option is chosen.
   if(focusMode(mode)){const all=fitReadableCamera(projected,box.width,box.height,topInset);crowdedOverview=crowdedOverview?overlapShare(positions.map((_,i)=>screenPoint(projected,i,all,box.width,box.height)))>.03:overlapShare(positions.map((_,i)=>screenPoint(projected,i,all,box.width,box.height)))>.1;}
   const focused=focusMode(mode)&&crowdedOverview&&!showAll.current&&featured.some(Boolean),fitTo=focused?projected.filter((_,k)=>featured[Math.floor(k/3)]===1):projected;
   if(fitting.current){
    if(fitPending){
     const next=fitReadableCamera(fitTo,box.width,box.height,topInset,focused?2:1.2);
     world=overviewSpan=next.span;camera={x:next.x,y:next.y};fitPending=false;
    }else if(focused){
     // Follow the active agents in both directions, slowly enough not to bounce.
     // A paused map holds its camera still.
     if(c.running){
      const next=fitReadableCamera(fitTo,box.width,box.height,topInset,2),blend=1-Math.exp(-dt/2500);
      world+=(next.span-world)*blend;overviewSpan=world;camera={x:camera.x+(next.x-camera.x)*blend,y:camera.y+(next.y-camera.y)*blend};
     }
    }else{
     overviewSpan=expandReadableCamera(fitTo,{...camera,span:overviewSpan},box.width,box.height,topInset).span;
     world+=(overviewSpan-world)*(1-Math.exp(-dt/700));
    }
   }
   const height=box.height,span=world/c.zoom,frame={...camera,span};
   const viewBox=`0 0 ${box.width} ${height}`;if(viewBox!==lastViewBox){vector.setAttribute('viewBox',viewBox);lastViewBox=viewBox;}
   const screen=positions.map((_,i)=>screenPoint(projected,i,frame,box.width,height));
   // Crowding: share of portraits overlapping a neighbour, with hysteresis so
   // the view does not flip between treatments as agents drift.
   if(mode!=='portraits'){
    dense=dense?overlapShare(screen)>.03:overlapShare(screen)>.1;
    let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;for(const p of screen){minX=Math.min(minX,p.x);maxX=Math.max(maxX,p.x);minY=Math.min(minY,p.y);maxY=Math.max(maxY,p.y);}
    shrink=Math.max(.4,Math.min(1,Math.sqrt(Math.max(1,(maxX-minX)*(maxY-minY))/screen.length)/60));
   }else dense=false;
   element.dataset.mapDense=String(dense);element.dataset.mapFocused=String(focused);
   // Agents grow and shrink over about 300 ms instead of snapping.
   const scaleBlend=reduced.matches?1:1-Math.exp(-dt/100);
   const scales=screen.map((_,i)=>{const target=mode==='shrink'?(featured[i]?1:shrink):(mode==='dots'||focusMode(mode))&&dense&&!featured[i]?(positions[i].personId?.45:.3):1;displayScale[i]+=(target-displayScale[i])*scaleBlend;if(Math.abs(target-displayScale[i])<.005)displayScale[i]=target;if(target!==displayScale[i])dirty=true;return displayScale[i];});
   for(const [i,node] of nodeElements.entries()){
    const transform=`translate(${screen[i].x},${screen[i].y})${scales[i]===1?'':` scale(${scales[i].toFixed(3)})`}`;if(node&&node.getAttribute('transform')!==transform)node.setAttribute('transform',transform);
    const wrapper=node?.parentElement;if(wrapper)wrapper.classList.toggle('is-dot',scales[i]<.6);
   }
   // Fit to active can leave quiet agents outside the view; say how many.
   const hidden=focused?screen.filter(p=>p.x<0||p.x>box.width||p.y<topInset||p.y>height).length:0;
   if(hidden!==outside&&outsideRef.current){outside=hidden;outsideRef.current.hidden=!hidden;outsideRef.current.firstElementChild!.textContent=`+${hidden} ${hidden===1?'agent':'agents'} outside view`;element.dataset.mapOutside=String(hidden);}
   // Paint far sprites first. Their size stays fixed; depth is expressed by
   // actual occlusion and orbit/parallax rather than unreadably small portraits.
   if(dimensions===3||c.highlightedOwner||depthOrder.length){
    // Lift highlighted billboards above the dimmed swarm, retaining depth order
    // within each group. This does not alter their world positions.
    const order=screen.map((_,i)=>i).sort((a,b)=>Number(!!c.highlightedOwner&&positions[a].ownerId===c.highlightedOwner)-Number(!!c.highlightedOwner&&positions[b].ownerId===c.highlightedOwner)||(dimensions===3?screen[a].z-screen[b].z:a-b));
    if(order.some((value,i)=>value!==depthOrder[i])){
     // Move only sprites whose depth order actually changed, preserving stable
     // nodes (and their accessible focus targets) between simulation frames.
     const focusedSprite=document.activeElement instanceof SVGElement&&vector.contains(document.activeElement)?document.activeElement:null;
     let next:Element|null=null;for(let i=order.length-1;i>=0;i--){const wrapper=nodeElements[order[i]]?.parentElement;if(wrapper){if(wrapper.nextElementSibling!==next)vector.insertBefore(wrapper,next);next=wrapper;}}
     if(focusedSprite&&document.activeElement!==focusedSprite)focusedSprite.focus({preventScroll:true});
     depthOrder=order;
    }
    if(dimensions===2&&!c.highlightedOwner)depthOrder=[];
   }
   const raster=canvas.current!,pixelWidth=Math.round(box.width*devicePixelRatio),pixelHeight=Math.round(height*devicePixelRatio);if(raster.width!==pixelWidth)raster.width=pixelWidth;if(raster.height!==pixelHeight)raster.height=pixelHeight;drawing.setTransform(devicePixelRatio,0,0,devicePixelRatio,0,0);drawing.clearRect(0,0,box.width,height);drawing.strokeStyle=getComputedStyle(element).getPropertyValue('--ink')||'#141414';drawing.fillStyle=drawing.strokeStyle;
   drawing.save();drawing.lineWidth=1;for(const line of worldGrid(frame,box.width,height,dimensions,orbit.current.yaw,orbit.current.pitch,floorY,gridRadius)){drawing.globalAlpha=line.major ? .12 : .065;drawing.beginPath();drawing.moveTo(line.x1,line.y1);drawing.lineTo(line.x2,line.y2);drawing.stroke();}drawing.restore();
   const passes=flights.sample(c.traffic,at,animationClock,c.replay,c.running);
   for(const sent of flights.takeStarts()){
    if(c.replay)continue;
    const position=index.get(sent.from);
    if(position!==undefined)nodeElements[position]?.querySelector('[data-character-avatar]')
      ?.dispatchEvent(new CustomEvent('character-message',{detail:{id:sent.id}}));
   }
   const byPair=new Map<string,number[]>();for(const flight of passes){const key=JSON.stringify([flight.from,flight.to]),values=byPair.get(key)??[];values.push(flight.phase);byPair.set(key,values);}
   edgeAppearance.begin(at,time,c.replay,c.running);
   for(const group of element.querySelectorAll<SVGGElement>('[data-map-edge]')){
    const from=group.dataset.from!,to=group.dataset.to!,a=index.get(from),b=index.get(to),link=weights.get(JSON.stringify([from,to]));
    if(a===undefined||b===undefined){group.style.display='none';continue;}
    const eligible=!!link&&link.weight>=EDGE_MIN_WEIGHT,dimmed=c.highlightedOwner&&positions[a].ownerId!==c.highlightedOwner&&positions[b].ownerId!==c.highlightedOwner;
    const appearance=edgeAppearance.sample(JSON.stringify([from,to]),eligible?(1-Math.exp(-link.weight))*.75*(dimmed ? .2 : 1):0,eligible?Math.min(4,1+Math.log2(1+link.weight)):1,time,reduced.matches||!c.running);
    // Inactive connections can finish their visual fade, but cannot be clicked.
    group.style.display=eligible?'':'none';if(appearance.opacity===0)continue;
    const x=screen[a].x,y=screen[a].y,dx=screen[b].x-x,dy=screen[b].y-y,length=Math.max(1,Math.hypot(dx,dy)),ra=24*scales[a],rb=26*scales[b],sx=x+dx/length*ra,sy=y+dy/length*ra,tx=x+dx-dx/length*rb,ty=y+dy-dy/length*rb;
    group.querySelector('path')!.setAttribute('d',`M ${sx} ${sy} L ${tx} ${ty}`);
    drawing.globalAlpha=appearance.opacity;drawing.lineWidth=appearance.width;drawing.beginPath();drawing.moveTo(sx,sy);drawing.lineTo(tx,ty);drawing.stroke();
    if(!reduced.matches)for(const phase of byPair.get(JSON.stringify([from,to]))??[]){drawing.beginPath();drawing.arc(sx+(tx-sx)*phase,sy+(ty-sy)*phase,4,0,Math.PI*2);drawing.fill();}
   }
   element.dataset.mapCamera=JSON.stringify(frame);element.dataset.mapRenderedDimensions=String(dimensions);element.dataset.mapFrames=String(Number(element.dataset.mapFrames??0)+1);element.dataset.mapAt=String(at);
   window.dispatchEvent(new Event('communication-map-tick'));
  };raf=requestAnimationFrame(paint);
  let drag:{x:number;y:number;cx:number;cy:number;yaw:number;pitch:number;orbit:boolean}|null=null;
  const down=(e:PointerEvent)=>{if(e.button!==0||(e.target as Element).closest('button,select,.k42-communication-agent,[data-map-edge]'))return;fitting.current=dimensions===3&&!e.shiftKey;control.current.onDismiss();drag={x:e.clientX,y:e.clientY,cx:camera.x,cy:camera.y,...orbit.current,orbit:dimensions===3&&!e.shiftKey};element.setPointerCapture(e.pointerId);};
  const move=(e:PointerEvent)=>{if(!drag)return;if(drag.orbit){orbit.current={yaw:drag.yaw+(e.clientX-drag.x)*.008,pitch:Math.max(-1.45,Math.min(1.45,drag.pitch+(e.clientY-drag.y)*.008))};}else{const scale=world/control.current.zoom/element.clientHeight;camera={x:drag.cx-(e.clientX-drag.x)*scale,y:drag.cy-(e.clientY-drag.y)*scale};}dirty=true;};
  const up=()=>{drag=null;};
  const keyboard=(e:KeyboardEvent)=>{if(e.target!==element)return;if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','=','-','Home'].includes(e.key))return;e.preventDefault();props.onDismiss();if(e.key==='Home'){home();return;}fitting.current=false;if(dimensions===3&&!e.shiftKey&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)){fitting.current=true;if(e.key==='ArrowLeft')orbit.current.yaw-=.15;if(e.key==='ArrowRight')orbit.current.yaw+=.15;if(e.key==='ArrowUp')orbit.current.pitch=Math.max(-1.45,orbit.current.pitch-.15);if(e.key==='ArrowDown')orbit.current.pitch=Math.min(1.45,orbit.current.pitch+.15);dirty=true;return;}if(['+','=','-'].includes(e.key)){zoomBy(e.key==='-'?1/1.4:1.4);return;}const d=world*.08/control.current.zoom;if(e.key==='ArrowLeft')camera.x-=d;if(e.key==='ArrowUp')camera.y-=d;if(e.key==='ArrowRight')camera.x+=d;if(e.key==='ArrowDown')camera.y+=d;dirty=true;};
  element.addEventListener('pointerdown',down);element.addEventListener('pointermove',move);element.addEventListener('pointerup',up);element.addEventListener('pointercancel',up);element.addEventListener('keydown',keyboard);
  return()=>{cancelAnimationFrame(raf);worker.onmessage=null;worker.onerror=null;worker.terminate();resize.disconnect();element.removeEventListener('map-frame',invalidate);element.removeEventListener('map-traffic',updateTraffic);element.removeEventListener('map-fit',fit);element.removeEventListener('pointerdown',down);element.removeEventListener('pointermove',move);element.removeEventListener('pointerup',up);element.removeEventListener('pointercancel',up);element.removeEventListener('keydown',keyboard);};
 },[key,retry]);
 useEffect(()=>{root.current?.dispatchEvent(new CustomEvent('map-traffic',{detail:props.traffic}));},[props.traffic]);
 useLayoutEffect(()=>{root.current?.dispatchEvent(new Event('map-frame'));},[props.at,props.running,props.speed,props.traffic,props.active,zoom,highlightedOwner,props.crowding,props.inspected]);
 useEffect(()=>{if(fitting.current)root.current?.dispatchEvent(new Event('map-fit'));},[props.crowding]);
 const controlsBlock=<>
  <div ref={controlsRef} className="communication-map-controls" role="group" aria-label="Map controls">
   {props.toolbarStart}
   <span className="communication-map-zoom"><button type="button" aria-label="Zoom out" onClick={()=>zoomBy(1/1.4)}>−</button><button type="button" onClick={home}>Fit map</button><button type="button" aria-label="Zoom in" onClick={()=>zoomBy(1.4)}>+</button></span>
  </div>
 </>;
 return <div className="communication-map" ref={root} tabIndex={0} onClick={event=>{if((event.target as Element).closest('button,select,.communication-map-controls,.k42-communication-agent,[data-map-edge]'))return;props.onSelect(null);props.onDismiss();}} data-map-dimensions={dimensions} data-state-motion={props.running&&props.active} data-owner-highlight={highlightedOwner} data-crowded={crowded} aria-label={dimensions===3?"3D communication map. Drag or use arrow keys to orbit; Shift plus drag or arrow keys to pan; plus and minus to zoom.":"Communication map. Drag to pan; arrow keys to move; plus and minus to zoom."}>
  <canvas ref={canvas} aria-hidden="true"/>
  <svg ref={svg} width="100%" height="100%" role="group" aria-label="Agent communication graph">
   {edgePool.map(e=><g key={JSON.stringify([e.from,e.to])} data-map-edge="" style={{display:'none'}} data-from={e.from} data-to={e.to} role="button" tabIndex={0} aria-label={`Show messages from ${props.nodes.find(n=>n.id===e.from)?.name??e.from} to ${props.nodes.find(n=>n.id===e.to)?.name??e.to}`} onClick={()=>props.onEdge(e.from,e.to)} onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();props.onEdge(e.from,e.to);}}}><path fill="none" stroke="transparent" strokeWidth="16"/></g>)}
   {visibleNodes.map(node=><g key={node.id} data-map-id={node.id} data-owner-id={node.ownerId??''} className={highlightedOwner&&node.ownerId!==highlightedOwner?'is-owner-dimmed':undefined} style={{'--owner-color':ownerColor(node.ownerId)} as CSSProperties}>{node.personId ? <PersonMapNode node={node} crowded={crowded} onInspect={anchor=>props.onInspect(node.id,anchor,false)} onLeave={props.onLeave} onDismiss={props.onDismiss} onSelect={()=>props.onSelect(node.id)} /> : <CommunicationAgentNode node={node} agent={props.observations.get(node.id)} now={props.now} selected={props.selected===node.id} replay={props.replay} simulated={props.simulatedStates} compact crowded={crowded} ownerLabel={node.ownerId?ownerLabels.get(node.ownerId):'Owner unknown'} tooltipId={props.tooltipId} inspecting={props.inspected===node.id} onInspect={anchor=>props.onInspect(node.id,anchor,false)} onLeave={props.onLeave} onDismiss={props.onDismiss} onSelect={()=>props.onSelect(node.id)}/>}</g>)}
  </svg>
  {props.controlsSlot?createPortal(controlsBlock,props.controlsSlot):controlsBlock}
  <p className="communication-map-outside" ref={outsideRef} hidden><span/> · <button type="button" onClick={()=>{showAll.current=true;fitting.current=true;setZoom(1);root.current?.dispatchEvent(new Event('map-fit'));}}>Show all</button></p>
  {dimensions===3&&<p className="communication-map-orbit-note">3D · Drag to orbit. Shift-drag to pan.</p>}
  {failure&&<div role="alert" className="communication-map-error">Map unavailable: {failure}. <button type="button" onClick={()=>setRetry(n=>n+1)}>Retry map</button></div>}
 </div>;
}
