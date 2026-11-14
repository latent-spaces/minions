import {useCallback,useEffect,useRef,useState} from 'react';
import {Maximize2,Minimize2} from 'lucide-react';
import {CommunicationMap} from '../../apps/web/src/ui/communication-map/CommunicationMap';
import {CommunicationAgentTooltip} from '../../apps/web/src/ui/CommunicationAgentNode';
import {ConnectionMessagePreview} from '../../apps/web/src/ui/communication-map/ConnectionMessagePreview';
import '../../apps/web/src/styles.css';
import '../../apps/web/src/ui/theme.css';
import '../../apps/web/src/ui/project-communication.css';
import '../../apps/web/src/ui/profile-page.css';
import '../../apps/web/src/ui/project-home.css';
import '../../apps/web/src/ui/application-shell.css';
import '../../apps/web/src/ui/segments.css';
import Review,{type Treatment} from './review';
import {normalizeToViewport} from '../../apps/web/src/ui/communication-map/viewport-layout';
import {sampleNodes as nodes,sampleCount,useSample} from './sample';
import './lab.css';

const params=new URLSearchParams(location.search);
/** Read-only synthetic host; every map pixel still comes from the production component. */
function Simulation(){
 const {at,playing,messages,observations,send,setPlaying,receive}=useSample(!params.has('embedded'));
 const [treatment,setTreatment]=useState<Treatment>('current');
 const [selected,setSelected]=useState<string|null>(null),[inspection,setInspection]=useState<{id:string;anchor:SVGGElement}|null>(null),[opened,setOpened]=useState<{from:string;to:string}|null>(null);
 const leaveTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
 const keep=()=>{if(leaveTimer.current)clearTimeout(leaveTimer.current);};
 const leave=()=>{keep();leaveTimer.current=setTimeout(()=>setInspection(null),180);};
 useEffect(()=>()=>keep(),[]);
 useEffect(()=>{if(!params.has('embedded'))return;const message=(event:MessageEvent)=>{if(event.origin!==location.origin||event.source!==parent||event.data?.type!=='lab-snapshot')return;receive(event.data.snapshot);setTreatment(event.data.treatment);};window.addEventListener('message',message);parent.postMessage({type:'lab-ready'},location.origin);return()=>window.removeEventListener('message',message);},[receive]);
 const loadSample=useCallback(async(id:string)=>messages.find(message=>message.id===id)?.body??'Sample message no longer retained.',[messages]);
 const openConversation=(from:string,to:string)=>{setInspection(null);setOpened({from,to});};
 const nodeName=(id:string)=>nodes.find(node=>node.id===id)?.name??id;
 const agent=inspection?observations.get(inspection.id):undefined;
 const [expanded,setExpanded]=useState(params.get('device')==='fullscreen'),[controlsSlot,setControlsSlot]=useState<HTMLDivElement|null>(null);
 const [measurement,setMeasurement]=useState('Measuring…');
 useEffect(()=>{const map=document.querySelector('.communication-map');if(!map)return;const measure=()=>{const r=map.getBoundingClientRect();setMeasurement(`Viewport ${innerWidth} × ${innerHeight} · map ${Math.round(r.width)} × ${Math.round(r.height)} CSS px · 100% scale`);};const observer=new ResizeObserver(measure);observer.observe(map);window.addEventListener('resize',measure);measure();return()=>{observer.disconnect();window.removeEventListener('resize',measure);};},[expanded]);
 const communication=<section className={`k42-swarm-panel k42-communication${expanded?' is-expanded':''}`}>
  <div className="k42-activity-heading"><div ref={setControlsSlot} className="k42-communication-controls-slot"/><button className="k42-communication-fullscreen" aria-label={params.get('device')==='fullscreen'?'Full screen':expanded?'Exit full screen':'Full screen'} onClick={()=>{if(params.get('device')==='fullscreen'){if(document.fullscreenElement)void document.exitFullscreen();else void document.documentElement.requestFullscreen();}else setExpanded(value=>!value);}}>{expanded?<Minimize2 size={18}/>:<Maximize2 size={18}/>}</button></div>
  <p className="k42-communication-refresh-status" aria-label="Refresh status"/>
  <div className="k42-communication-body"><div className="k42-communication-network"><div className="k42-communication-graph"><div className="k42-communication-map-stage">
  <CommunicationMap labelMode={treatment==='fill'||treatment==='smart'?'compact':treatment==='inspect'?'inspect':'full'} personScale={1.25} viewportLayout={treatment==='fill'?normalizeToViewport:null} controlsSlot={controlsSlot} toolbarStart={<span className="k42-map-counts">1 person · {sampleCount-1} agents shown</span>} crowding="focus-active" nodes={nodes} traffic={messages} at={at} now={at} running={playing} active replay={false} simulatedStates speed={1} observations={observations} selected={selected} inspected={inspection?.id??null} tooltipId="lab-agent-detail" onInspect={(id,anchor)=>{keep();setInspection({id,anchor});}} onLeave={leave} onDismiss={()=>{keep();setInspection(null);}} onSelect={setSelected} onEdge={openConversation} renderEdgePreview={messageId=><ConnectionMessagePreview messageId={messageId} loadMessage={loadSample} href="#sample-conversation" onOpen={()=>{const message=messages.find(row=>row.id===messageId);if(message)openConversation(message.agentId,message.to[0]);}}/>}/>
  </div></div></div></div>
 </section>;
 return <div className="lab-simulation" data-treatment={treatment}><div className="lab-measurement">{measurement}<span>Synthetic data</span>{!params.has('embedded')&&<><button onClick={()=>setPlaying(value=>!value)}>{playing?'Pause':'Play'}</button><button onClick={send}>Send sample message</button><span role="status">{messages.filter(message=>message.id.startsWith('new-')).length} new messages · {playing?'Sending every 4s':'Paused'}</span></>}</div>
 <div className="page workspace"><div className="workspace-layout"><aside className="project-sidebar lab-shell-sidebar"><strong>MyLittleSwarm</strong><p>Synthetic project</p><p>Tasks</p><p>Agents</p><p>Conversations</p></aside><div className="workspace-column"><main className="workspace-content"><div className="k42-project-layout"><div className="k42-project-main"><h1>Sample project</h1><p>Synthetic workspace · production layout CSS</p><div className="lab-message-log"><h2>Sample messages</h2><p>No live messages or agents.</p><ol>{messages.slice(-12).reverse().map(message=><li key={message.id}><button onClick={()=>openConversation(message.agentId,message.to[0])}><strong>{nodeName(message.agentId)} → {nodeName(message.to[0])}</strong><span>{message.body}</span></button></li>)}</ol></div></div><aside className="k42-updates-panel" data-open aria-label="Project updates and map"><div className="k42-task-segments k42-panel-switch"><button className="k42-task-segment" disabled>Updates</button><button className="k42-task-segment" aria-pressed="true">Map</button></div>{!expanded&&communication}</aside></div></main></div></div></div>
 {expanded&&communication}
  {inspection&&agent&&<CommunicationAgentTooltip id="lab-agent-detail" anchor={inspection.anchor} name={agent.name} agentId={agent.id} ownerLabel="Sample person" ownerId="demo" agent={agent} now={at} replay={false} simulated onKeep={keep} onLeave={leave} onDismiss={()=>setInspection(null)}/>}
  {opened&&<div className="lab-conversation" role="dialog" aria-modal="true" aria-label="Synthetic conversation" onKeyDown={event=>{if(event.key==='Escape')setOpened(null);}}><header><h2>{nodeName(opened.from)} ↔ {nodeName(opened.to)}</h2><button autoFocus onClick={()=>setOpened(null)}>Close conversation</button></header><p>Synthetic conversation · no live agents</p><ol>{messages.filter(message=>message.agentId===opened.from&&message.to.includes(opened.to)||message.agentId===opened.to&&message.to.includes(opened.from)).map(message=><li key={message.id}><strong>{nodeName(message.agentId)}</strong><p>{message.body}</p></li>)}</ol></div>}
 </div>;
}

export default function Lab(){return params.has('embedded')?<Simulation/>:<Review/>;}
