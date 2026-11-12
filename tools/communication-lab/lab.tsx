import {useEffect,useRef,useState} from 'react';
import {CommunicationMap,type ConnectorStyle} from '../../apps/web/src/ui/communication-map/CommunicationMap';
import {agentCharacter} from '../../apps/web/src/ui/character-set';
import type {Traffic} from '../../apps/web/src/ui/communication-map/layout';
import '../../apps/web/src/styles.css';
import '../../apps/web/src/ui/theme.css';
import '../../apps/web/src/ui/project-communication.css';
import '../../apps/web/src/ui/profile-page.css';
import './lab.css';
const styles:{id:ConnectorStyle;name:string;detail:string}[]=[
 {id:'current',name:'Current ink',detail:'The existing straight line and single message dot.'},
 {id:'lavender',name:'Soft lavender',detail:'Thinner, muted line with a smaller message dot.'},
 {id:'packet-trail',name:'Small dot trail',detail:'Thin straight line with three small dots per message.'},
 {id:'envelope',name:'Tiny envelope',detail:'A small outlined paper envelope, only while a message travels.'},
 {id:'tube',name:'Soft tube',detail:'A thin, rounded tube with a small traveling swell.'},
 {id:'round-tube',name:'Round bulge',detail:'A softer pill-shaped bulge around a small warm bead.'},
 {id:'rubber-tube',name:'Rubber tube',detail:'A chunkier tube with round ends and a plumper swallow.'},
];
const identityFor=(animal:string)=>{let i=0;while(agentCharacter(`lab-agent-${i}`).id!==animal)i++;return `lab-agent-${i}`;};
const nodes=[
 {id:'person:demo',personId:'demo',character:'person-03' as const,name:'You',ownerId:'demo',ownerName:'You'},
 {id:identityFor('fox'),name:'Builder',ownerId:'demo',ownerName:'You'},
 {id:identityFor('owl'),name:'Reviewer',ownerId:'demo',ownerName:'You'},
 {id:identityFor('frog'),name:'Explorer',ownerId:'demo',ownerName:'You'},
];
const pairs=[[nodes[0].id,nodes[1].id],[nodes[1].id,nodes[2].id],[nodes[2].id,nodes[3].id]];
const observations=new Map();
const noop=()=>{};
const start=Date.now();
const message=(index:number,at:number):Traffic=>({id:`demo-${index}`,agentId:pairs[index%pairs.length][0],to:[pairs[index%pairs.length][1]],audience:'direct',createdAt:at});
export default function Lab(){
 const [view,setView]=useState<ConnectorStyle|'all'|'tubes'>('tubes');
 const [playing,setPlaying]=useState(true),[at,setAt]=useState(start);
 const [messages,setMessages]=useState<Traffic[]>(pairs.map((_,i)=>message(i,start-1000)));
 const [sequence,setSequence]=useState(3);
 const clock=useRef(at);clock.current=at;
 useEffect(()=>{if(!playing)return;let previous=performance.now();const timer=setInterval(()=>{const now=performance.now(),elapsed=now-previous;previous=now;if(!document.hidden)setAt(value=>value+elapsed);},100);return()=>clearInterval(timer);},[playing]);
 // Only synthetic events create packets. All maps receive exactly the same events.
 const send=()=>{setMessages(rows=>[...rows.slice(-19),message(sequence,clock.current+1)]);setSequence(value=>value+1);setAt(value=>value+1);};
 useEffect(()=>{if(!playing)return;const timer=setInterval(send,4000);return()=>clearInterval(timer);},[playing,sequence]);
 return <main className="connector-lab"><h1>Communication connectors</h1>
  <p>Straight connector experiments on the existing map. Four synthetic characters; no live data or agents.</p>
  <div className="connector-controls"><button onClick={()=>setPlaying(value=>!value)}>{playing?'Pause':'Play'}</button><button disabled={!playing} onClick={send}>Send sample message</button><label>View <select aria-label="View" value={view} onChange={e=>setView(e.target.value as ConnectorStyle|'all'|'tubes')}><option value="tubes">Compare tubes</option><option value="all">Compare all</option>{styles.map(style=><option key={style.id} value={style.id}>{style.name}</option>)}</select></label><span>Same layout and traffic · straight lines in every option</span></div>
  <div className={`connector-options${view==='tubes'?' is-tubes':view!=='all'?' is-focused':''}`}>{styles.filter(style=>view==='all'||(view==='tubes'?style.id.includes('tube'):style.id===view)).map(style=><section key={style.id}><h2>{style.name}</h2><p>{style.detail}</p>
   <CommunicationMap connectorStyle={style.id} nodes={nodes} traffic={messages} at={at} now={at} running={playing} active replay={false} speed={1} observations={observations} selected={null} inspected={null} tooltipId={`lab-${style.id}`} onInspect={noop} onLeave={noop} onDismiss={noop} onSelect={noop} onEdge={noop}/>
  </section>)}</div>
 </main>;
}
