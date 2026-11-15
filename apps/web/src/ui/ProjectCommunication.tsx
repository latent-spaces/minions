import { subscribeRealtime } from '../realtime';
import { PersonProfilePopup } from './PersonProfilePopup';
import type { DirectoryMember } from '../community-directory';
import { projectRoute,formatRoute } from '../route';
import {ConnectionMessagePreview} from './communication-map/ConnectionMessagePreview';
import {ApiError} from '../authorized-request';
import {refreshOnReturn} from '../refresh-on-return';
import {walkDue} from '../all-pages';
import {readMapRoster,type MapAgent,type RosterPage} from './communication-map/read-roster';
import {CommunicationMap} from './communication-map/CommunicationMap';
import {CURRENT_STATE_FAST_POLL_MS,CURRENT_STATE_POLL_MS,accessRefused,createCurrentStateMap,currentStateRound,type CurrentStateMap,type CurrentStateRound} from './communication-map/current-state-source';
import type {CurrentStateAnswer} from './communication-map/current-state-reader';
import {connectionMessageId,readTrafficFrame,reuseTraffic,type TrafficPage,type TrafficRead} from './communication-map/read-traffic';
import type {Traffic} from './communication-map/layout';
import {useCallback,useEffect,useId,useMemo,useRef,useState,type ReactNode} from 'react';
import type { SessionUser } from '../session-identity';
import type {CommunicationAgent,CommunicationAgents} from '@minions/contracts';
import {CircleAlert,Link,Maximize2,Minimize2} from 'lucide-react';
import {PersonAvatar} from './PersonAvatar';
import {AgentAvatar} from './AgentAvatar';
import {read,type AgentRow,type MessageRow} from '../api';
import type {Route} from '../route';
import {Button} from './Button';
import type {CommunicationNode} from './agent-map';
import './project-communication.css';
import {CommunicationAgentTooltip} from './CommunicationAgentNode';
import {useMyWorkers} from './MyWorkerControls';
import {AgentRunActions} from './AgentRunControls';
import {workerAgentStatus} from './agent-running-state';
import {Tooltip} from './Tooltip';
import {ProjectPauseStatus} from './ProjectPauseStatus';
import {createPortal} from 'react-dom';
import {AddAgentPrompt,useAddAgentPrompt} from './AddAgentPrompt';

type LiveFrame={at:number;serverTime:number;nodes:CommunicationNode[];messages:MessageRow[];trafficMark?:string|null};
function ProjectCommunicationView({user,projectId,projectName,active,agents,go,addAgent,closed=false,pauseRequest,onOpenAgent,onCopyLink}:{onCopyLink?:(()=>void)|null;pauseRequest?:{revision:number;requestedAt:number};onOpenAgent?:(id:string)=>void;projectName?:string;user:SessionUser;projectId:string;active:boolean;agents:AgentRow[];go:(r:Route)=>void;addAgent?:ReactNode;closed?:boolean}){
 const id=useId().replace(/:/g,''),[snapshot,setSnapshot]=useState<LiveFrame|null>(null),[error,setError]=useState<string|null>(null),[selected,setSelected]=useState<string|null>(null);
 const [pulse,setPulse]=useState(0),[loading,setLoading]=useState(false),[readNotice,setReadNotice]=useState(false);
 const [traffic,setTraffic]=useState<Traffic[]>([]),[trafficError,setTrafficError]=useState<string|null>(null),[trafficRetry,setTrafficRetry]=useState(0);
 const lastTraffic=useRef<TrafficRead|null>(null);
 const previewReads=useRef(new Map<string,Promise<string>>());
 const loadEdgeMessage=useCallback((messageId:string)=>{
  const cache=previewReads.current;
  const previous=cache.get(messageId);if(previous)return previous;
  if(cache.size>=32)cache.delete(cache.keys().next().value!);
  const pending=read<{message:MessageRow}>(user,'/messages/'+encodeURIComponent(messageId),projectId).then(value=>value.message.body).catch(error=>{cache.delete(messageId);throw error;});
  cache.set(messageId,pending);return pending;
 },[user,projectId]);
 const [observations,setObservations]=useState<CommunicationAgents|null>(null),[statusError,setStatusError]=useState(false),[observedPauseRevision,setObservedPauseRevision]=useState<number|null>(null),[statusRounds,setStatusRounds]=useState('');
 const fastPauseFeedback=!!pauseRequest&&Date.now()-pauseRequest.requestedAt<60000;
 const [wall,setWall]=useState(0),clock=useRef({at:0,received:0}),observationReceived=useRef(0),blockedUntil=useRef(0),refresh=useRef<(()=>void)|null>(null);
 const [controlsSlot,setControlsSlot]=useState<HTMLDivElement|null>(null),panel=useRef<HTMLElement>(null),fullscreenTrigger=useRef<HTMLButtonElement>(null),[expanded,setExpanded]=useState(false),activeRef=useRef(active);activeRef.current=active;
 const [inspected,setInspected]=useState<{id:string;anchor:SVGGElement}|null>(null),pinned=useRef(false),tooltipTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
 const keepTooltip=useCallback(()=>{if(tooltipTimer.current)clearTimeout(tooltipTimer.current);},[]);
 const dismissTooltip=useCallback(()=>{keepTooltip();pinned.current=false;setInspected(null);},[keepTooltip]);
 const leaveTooltip=useCallback(()=>{keepTooltip();if(!pinned.current)tooltipTimer.current=setTimeout(()=>setInspected(null),150);},[keepTooltip]);
 useEffect(()=>()=>keepTooltip(),[keepTooltip]);
 useEffect(()=>{if(!active)dismissTooltip();},[active,dismissTooltip]);useEffect(()=>dismissTooltip(),[expanded,dismissTooltip]);
 useEffect(()=>{
  const changed=()=>{if(!document.fullscreenElement)setExpanded(false);};
  const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'&&!document.querySelector('dialog[open]')){if(document.fullscreenElement===panel.current)void document.exitFullscreen().catch(()=>undefined);setExpanded(false);}};
  document.addEventListener('fullscreenchange',changed);document.addEventListener('keydown',escape);
  return()=>{document.removeEventListener('fullscreenchange',changed);document.removeEventListener('keydown',escape);};
 },[]);
 useEffect(()=>{if(!active&&expanded){if(document.fullscreenElement===panel.current)void document.exitFullscreen().catch(()=>undefined);setExpanded(false);}},[active,expanded]);
 useEffect(()=>{
  if(!expanded)return;fullscreenTrigger.current?.focus();
  const trap=(event:KeyboardEvent)=>{if(event.key!=='Tab'||document.querySelector('dialog[open]'))return;const controls=[...(panel.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]')??[])].filter(e=>e.getClientRects().length),first=controls[0],last=controls.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&(document.activeElement===last||!panel.current?.contains(document.activeElement))){event.preventDefault();first?.focus();}};
  document.addEventListener('keydown',trap);return()=>{document.removeEventListener('keydown',trap);if(activeRef.current)requestAnimationFrame(()=>{if(activeRef.current)fullscreenTrigger.current?.focus();});};
 },[expanded]);
 useEffect(()=>{const element=panel.current;if(!active||!expanded||!element||document.fullscreenElement)return;let cancelled=false;void element.requestFullscreen?.().then(()=>{if(cancelled&&document.fullscreenElement===element)void document.exitFullscreen().catch(()=>undefined);}).catch(()=>undefined);return()=>{cancelled=true;};},[active,expanded]);
 const toggleFullScreen=()=>{if(expanded&&document.fullscreenElement===panel.current)void document.exitFullscreen().catch(()=>undefined);setExpanded(value=>!value);};
 useEffect(()=>{if(!active)return;const timer=setInterval(()=>setWall(performance.now()),1000),poll=setInterval(()=>setPulse(p=>p+1),60000);return()=>{clearInterval(timer);clearInterval(poll);};},[active]);
 useEffect(()=>{
  if(!active)return;let cancelled=false,busy=false,queued=false,liveTimer:ReturnType<typeof setTimeout>|undefined;
  const load=async()=>{if(cancelled)return;if(busy){queued=true;return;}if(Date.now()<blockedUntil.current)return;busy=true;setLoading(true);
   try{const frame=await read<LiveFrame>(user,'/communication?range=recent',projectId);if(!cancelled){setSnapshot(frame);setError(null);setReadNotice(false);clock.current={at:frame.serverTime,received:performance.now()};}}
   catch(failure){if(!cancelled){if(failure instanceof ApiError&&failure.status===429){blockedUntil.current=Date.now()+(failure.retryAfterMs??60000);setReadNotice(true);}else setError(failure instanceof Error?failure.message:'Communication unavailable');}}
   finally{busy=false;if(!cancelled){setLoading(false);if(queued){queued=false;void load();}}}
  };
  const stopLive=subscribeRealtime(user,projectId,topics=>{if(topics.includes('conversations')&&!liveTimer)liveTimer=setTimeout(()=>{liveTimer=undefined;void load();},5000);});
  refresh.current=()=>void load();const stop=refreshOnReturn(()=>void load());void load();return()=>{cancelled=true;refresh.current=null;clearTimeout(liveTimer);stop();stopLive();};
 },[user,projectId,active]);
 useEffect(()=>{if(active&&pulse)refresh.current?.();},[active,pulse]);
 const [roster,setRoster]=useState<MapAgent[]>([]),[rosterLoading,setRosterLoading]=useState(false),[rosterLoaded,setRosterLoaded]=useState(false),[rosterError,setRosterError]=useState<string|null>(null),[rosterRetry,setRosterRetry]=useState(0);
 // Only the first roster walk renders progressively. Later refreshes replace the roster once complete,
 // so a background refresh neither shrinks the graph nor cancels the status sweep below.
 const rosterShown=useRef(false);
 // Rosters above ten pages refresh in proportion to the pages they read (walkDue); Retry agents reads at once.
 const rosterWalk=useRef<{pages:number;startedAt:number}|null>(null);
 useEffect(()=>{
  if(!active)return;let cancelled=false,busy=false;
  const load=async(forced:boolean)=>{if(cancelled||busy||!forced&&!walkDue(rosterWalk.current,Date.now(),60000))return;busy=true;setRosterLoading(true);setRosterError(null);const progressive=!rosterShown.current,startedAt=Date.now();let latest:MapAgent[]|null=null,pages=0;try{await readMapRoster(cursor=>{pages++;return read<RosterPage>(user,'/communication/roster'+(cursor?'?'+new URLSearchParams({cursor}):''),projectId);},rows=>{if(progressive)setRoster(rows);else latest=rows;},()=>!cancelled);if(!cancelled){rosterWalk.current={pages,startedAt};if(latest)setRoster(latest);}}catch(failure){if(!cancelled)rosterWalk.current={pages,startedAt};if(!cancelled)setRosterError(failure instanceof Error?failure.message:'Could not load agents');}finally{busy=false;if(!cancelled){setRosterLoading(false);rosterShown.current=true;setRosterLoaded(true);}}};
  void load(rosterRetry>0);const timer=setInterval(()=>void load(false),60000);return()=>{cancelled=true;clearInterval(timer);};
 },[user,projectId,active,rosterRetry]);
 const peopleWalk=useRef<{pages:number;startedAt:number}|null>(null);
 const [people,setPeople]=useState<DirectoryMember[]>([]),[peopleError,setPeopleError]=useState(''),[peopleRetry,setPeopleRetry]=useState(0),[person,setPerson]=useState<DirectoryMember|null>(null);
 useEffect(()=>{
  if(!active)return;let current=true,busy=false;
  // Large member lists refresh in proportion to the pages they read, including after a failure; Retry always reads now.
  const load=async(forced:boolean)=>{if(!current||busy||!forced&&!walkDue(peopleWalk.current,Date.now(),60000))return;busy=true;const startedAt=Date.now();let pages=0;try{const rows=new Map<string,DirectoryMember>(),cursors=new Set<string>();let cursor:string|null=null;
   do{const page: {members:DirectoryMember[];next:string|null}=await read<{members:DirectoryMember[];next:string|null}>(user,'/members'+(cursor?'?'+new URLSearchParams({cursor}):''),projectId);pages++;if(!current)return;for(const member of page.members)rows.set(member.id,member);cursor=page.next;if(cursor&&cursors.has(cursor))throw Error('Repeated members cursor');if(cursor)cursors.add(cursor);}while(cursor);
   if(current){setPeople([...rows.values()]);setPeopleError('');}
  }finally{busy=false;if(current)peopleWalk.current={pages,startedAt};}};
  const refresh=(forced:boolean)=>void load(forced).catch(failure=>{if(current)setPeopleError(failure.message);});refresh(peopleRetry>0);const timer=setInterval(()=>refresh(false),60000);return()=>{current=false;clearInterval(timer);};
 },[user,projectId,active,peopleRetry]);
 useEffect(()=>{if(!active)setPerson(null);},[active]);
 // Only the paged roster determines graph membership. A stale parent preview
 // must not restore a retired agent when status observations are unavailable.
 const nodes=useMemo(()=>roster.map(({id,name,provider})=>({id,name,provider})),[roster]);
 const ownerNames=new Map([...people.map(person=>[person.id,person.name??'Project member'] as const),...agents.filter(a=>a.operatorId&&a.operatorName).map(a=>[a.operatorId,a.operatorName] as const)]);
 const ownersById=new Map([...agents,...roster].map(a=>[a.id,a.operatorId]));
 // The map's status read is the current-state endpoint (current-state-source.ts), the only one: it polls every 15 s, every
 // 2 s while a project Pause awaits confirmation. Until a first read completes no states are shown. A failed read (5xx,
 // network) keeps what is shown, says so, and is retried next round; an access refusal (401/403/404) also clears the
 // reader and what is shown. data-status-rounds counts every poll round by what it rested on (current/held/pending, or
 // error), so acceptance tests have denominators.
 const currentState=useRef<{key:string;map:CurrentStateMap;rounds:Record<CurrentStateRound['served']|'error',number>}|null>(null);
 useEffect(()=>{
  if(!active||!rosterLoaded||!user)return;let cancelled=false,busy=false,queued=false,timer:ReturnType<typeof setTimeout>|undefined;
  const key=`${user.uid}:${projectId}`;
  if(currentState.current?.key!==key)currentState.current={key,map:createCurrentStateMap(),rounds:{current:0,held:0,pending:0,error:0}};
  const own=currentState.current;
  const count=(served:keyof typeof own.rounds)=>{own.rounds[served]++;setStatusRounds(Object.entries(own.rounds).map(([k,v])=>`${k}:${v}`).join(' '));};
  const load=async()=>{if(cancelled)return;if(busy){queued=true;return;}busy=true;clearTimeout(timer);let next=fastPauseFeedback?CURRENT_STATE_FAST_POLL_MS:CURRENT_STATE_POLL_MS;try{
   const round=await currentStateRound(own.map,path=>read<CurrentStateAnswer<CommunicationAgent>>(user,path,projectId),fastPauseFeedback);if(cancelled)return;
   own.map=round.state;count(round.served);next=round.nextMs;setStatusError(false);
   if(round.observations){observationReceived.current=performance.now();setObservations(round.observations);setObservedPauseRevision(pauseRequest?.revision??null);}
  }catch(failure){if(cancelled)return;count('error');setStatusError(true);
   if(accessRefused(failure)){own.map=createCurrentStateMap();setObservations(null);}
  }finally{busy=false;if(!cancelled){timer=setTimeout(()=>void load(),queued?0:next);queued=false;}}};
  const stopLive=subscribeRealtime(user,projectId,topics=>{if(topics.includes('agents')||topics.includes('needs-you'))void load();});
  const stop=refreshOnReturn(()=>void load());void load();return()=>{cancelled=true;if(timer)clearTimeout(timer);stop();stopLive();};
 },[active,user,projectId,rosterLoaded,pauseRequest?.revision,fastPauseFeedback]);
 useEffect(()=>{
  if(!active||!snapshot)return;let cancelled=false;setTrafficError(null);
  // A frame whose window gained no shared message keeps the last rows, aged to its window, instead of re-reading them.
  const reused=reuseTraffic(lastTraffic.current,snapshot.at,snapshot.trafficMark);
  if(reused){setTraffic(reused);return;}
  const frame={at:snapshot.at,mark:snapshot.trafficMark??null};
  void readTrafficFrame(snapshot.at,query=>{if(cancelled)throw Error('Graph frame cancelled');return read<TrafficPage>(user,'/communication/traffic?'+query,projectId);}).then(rows=>{if(!cancelled){lastTraffic.current={...frame,rows};setTraffic(rows);}},failure=>{if(!cancelled)setTrafficError(failure instanceof Error?failure.message:'Graph traffic unavailable');});return()=>{cancelled=true;};
 },[user,projectId,active,snapshot?.at,trafficRetry]);
 const statusById=new Map(observations?.agents.map(agent=>[agent.id,agent]));
 // Recent history cannot restore a retired identity to the live graph. Observations
 // fence cached directory/roster rows until their next paged refresh.
 const liveNodes=nodes.filter(node=>statusById.get(node.id)?.state!=='revoked');
 const liveIds=new Set([...liveNodes.map(node=>node.id),...people.map(person=>`person:${person.id}`)]);
 const liveKey=[...liveIds].sort().join('|');
 const liveTraffic=useMemo(()=>{const ids=new Set(liveKey.split('|'));return traffic.filter(row=>ids.has(row.agentId)).map(row=>({...row,to:row.to.filter(id=>ids.has(id))}));},[traffic,liveKey]);
 const at=snapshot?clock.current.at+Math.max(0,wall-clock.current.received):0,now=observations?observations.serverTime+Math.max(0,wall-observationReceived.current):at,inspectedNode=inspected&&liveNodes.find(node=>node.id===inspected.id);
 const invite=useAddAgentPrompt(projectName),workers=useMyWorkers(),ownRow=inspected&&statusById.get(inspected.id)?.mine?workers?.data?.agents.find(row=>row.agentId===inspected.id):undefined;
 const crowd=[...people.map(person=>({key:`p${person.id}`,node:<PersonAvatar id={person.id} photo={person.photo} character={person.character} name={person.name} size={32}/>,label:person.name??'Project member'})),
  ...agents.filter(agent=>agent.revokedAt===null&&liveIds.has(agent.id)).map(agent=>({key:`a${agent.id}`,node:<AgentAvatar provider={agent.usage?.provider} name={agent.name} id={agent.id} persona={agent.personaChoice} ownerName={agent.operatorName} ownerId={agent.operatorId} size={32}/>,label:agent.name}))],shown=crowd.slice(0,8);
 const toolbarStart=<>
  {!!crowd.length&&<ul className="k42-map-crowd" aria-label="People and agents">{shown.map(item=><li key={item.key} data-tip={item.label}>{item.node}{item.key.startsWith('p')&&<span className="visually-hidden">{item.label}</span>}</li>)}{crowd.length>shown.length&&<li><span className="is-more" title={`${crowd.length-shown.length} more`}>+{crowd.length-shown.length}</span></li>}</ul>}
  {/* How many, beside the faces (Noa, 27 October 2026). */}
  {!!crowd.length&&<span className="k42-map-counts">{people.length} {people.length===1?'person':'people'} · {liveNodes.length} {liveNodes.length===1?'agent':'agents'} shown</span>}
  {onCopyLink&&<Tooltip label="Copy project link" side="bottom"><button type="button" className="k42-map-share" aria-label="Copy project link" onClick={onCopyLink}><Link size={18} aria-hidden="true"/></button></Tooltip>}
 </>;
 const conversationRoute=(messageId:string|null):Route=>({view:'project',projectId,section:'conversations',thread:messageId,message:messageId??undefined,agent:null,q:null});
 const openConversation=(messageId:string|null)=>{dismissTooltip();if(document.fullscreenElement===panel.current)void document.exitFullscreen().catch(()=>undefined);setExpanded(false);go(conversationRoute(messageId));};
 const content=<section ref={panel} className={`k42-swarm-panel k42-communication${expanded?' is-expanded':''}`} aria-labelledby={`${id}-title`} role={expanded?'dialog':undefined} aria-modal={expanded||undefined}>
  <div className="k42-activity-heading"><h2 id={`${id}-title`} className="visually-hidden">Communication</h2>
   <div ref={setControlsSlot} className="k42-communication-controls-slot"/>
   <button ref={fullscreenTrigger} type="button" className="k42-communication-fullscreen" aria-pressed={expanded} aria-label={expanded?'Exit full screen':'Full screen'} onClick={toggleFullScreen}>{expanded?<Minimize2 size={18}/>:<Maximize2 size={18}/>}</button>
  </div>
  <p className="k42-communication-refresh-status" role="status" title={readNotice?`Updates will resume shortly.${snapshot?' Showing the last loaded view.':''}`:undefined}>{readNotice&&<>Updates will resume shortly.{snapshot?' Showing the last loaded view.':''}</>}</p>
  {pauseRequest&&!closed&&<ProjectPauseStatus request={pauseRequest} agents={observations?.agents.filter(agent=>liveIds.has(agent.id))??[]} now={now||Date.now()} incomplete={rosterLoading||!!rosterError||statusError||!!liveNodes.length&&(!observations||observedPauseRevision!==pauseRequest.revision||liveNodes.some(node=>!statusById.has(node.id)))} />}
  {error&&<p role="alert">Could not refresh communication. {error} <Button onClick={()=>refresh.current?.()}>Try again</Button></p>}
  <div className="k42-communication-body" aria-busy={loading}><div className="k42-communication-network"><div className="k42-communication-graph">
   <div className="k42-communication-map-stage" data-status-rounds={statusRounds||undefined}><CommunicationMap key={projectId} crowding="focus-active" controlsSlot={controlsSlot} toolbarStart={toolbarStart} nodes={[...liveNodes.map(n=>({...n,ownerId:ownersById.get(n.id)??null,ownerName:ownerNames.get(ownersById.get(n.id)??'')??null})),...people.map(person=>({id:`person:${person.id}`,personId:person.id,name:person.name,photo:person.photo,character:person.character,ownerId:person.id,ownerName:person.name}))]} traffic={liveTraffic} at={at} running={active&&!closed} speed={1} active={active&&!!snapshot} replay={false} now={now} observations={statusById} selected={selected} inspected={inspected?.id??null} tooltipId={`${id}-agent-tooltip`}
    onInspect={(agentId,anchor,pin)=>{if(pinned.current&&!pin)return;keepTooltip();pinned.current=pin;setInspected({id:agentId,anchor});}} onLeave={leaveTooltip} onDismiss={dismissTooltip}
    onSelect={nodeId=>{if(!nodeId){setSelected(null);return;}const member=people.find(person=>`person:${person.id}`===nodeId);if(member){dismissTooltip();setPerson(member);return;}dismissTooltip();if(document.fullscreenElement===panel.current)void document.exitFullscreen().catch(()=>undefined);setExpanded(false);if(onOpenAgent)onOpenAgent(nodeId);else go(projectRoute(projectId,'agents',nodeId,null));}}
    onEdge={(from,to)=>openConversation(connectionMessageId(traffic,from,to,at))}
    renderEdgePreview={messageId=><ConnectionMessagePreview messageId={messageId} loadMessage={loadEdgeMessage} href={formatRoute(conversationRoute(messageId))} onOpen={()=>openConversation(messageId)}/>}/>
   </div>
   {invite&&<div className="k42-communication-invite"><span className="k42-notice-icon" aria-hidden="true"><CircleAlert size={20}/></span><div><AddAgentPrompt prompt={invite}/></div></div>}
   {(loading||!invite)&&!nodes.length&&!people.length&&<div className="k42-communication-empty"><strong>{loading?'Loading communication…':'No agents yet'}</strong><p>Agents appear here as soon as someone adds one.</p></div>}
   {addAgent&&<div className="k42-communication-add-agent is-map">{addAgent}<span aria-hidden="true">Add agent</span></div>}
  </div>{trafficError&&<p role="status">Recent connections unavailable: {trafficError} <Button onClick={()=>setTrafficRetry(n=>n+1)}>Retry connections</Button></p>}{statusError&&<p role="status">Current agent states are unavailable. Communication history is still shown.</p>}</div></div>
  {peopleError&&<p role="status">Could not refresh people. {peopleError} <Button onClick={()=>setPeopleRetry(n=>n+1)}>Retry people</Button></p>}
  {person&&<PersonProfilePopup key={person.id} person={person} onClose={()=>setPerson(null)}/>}
  {rosterLoading&&!rosterLoaded&&<p role="status" className="muted">Loading agents · {roster.length} loaded</p>}
  {rosterError&&<p role="status">Showing {nodes.length} loaded agents. {rosterError} <Button onClick={()=>setRosterRetry(n=>n+1)}>Retry agents</Button></p>}
  {inspected&&inspectedNode&&<CommunicationAgentTooltip provider={inspectedNode && inspectedNode.provider} id={`${id}-agent-tooltip`} anchor={inspected.anchor} portalContainer={expanded?panel.current??undefined:undefined} name={inspectedNode.name??inspectedNode.id} agentId={inspected.id} ownerId={ownersById.get(inspected.id)} ownerLabel={ownerNames.get(ownersById.get(inspected.id)??'')??(statusById.get(inspected.id)?.mine?'You':undefined)} agent={statusById.get(inspected.id)} now={now} replay={false}
   {...(ownRow?{ownStatus:workerAgentStatus(ownRow,workers!.now).label,actions:<AgentRunActions user={user} projectId={projectId} agent={ownRow} controls={workers!} now={workers!.now} disabled={false} compact/>}:{})} onKeep={keepTooltip} onLeave={leaveTooltip} onDismiss={dismissTooltip} onPin={()=>{keepTooltip();pinned.current=true;}}/>}
 </section>;
 return expanded?createPortal(content,document.body):content;
}
export function ProjectCommunication(props:Parameters<typeof ProjectCommunicationView>[0]){return <ProjectCommunicationView key={`${props.user.uid}:${props.projectId}`} {...props}/>;}
