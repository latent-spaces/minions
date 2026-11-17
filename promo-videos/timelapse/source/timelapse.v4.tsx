import {useEffect,useMemo,useState,type CSSProperties} from 'react';
import type {CommunicationAgent} from '@minions/contracts';
import {CommunicationMap} from '@repo/apps/web/src/ui/communication-map/CommunicationMap';
import type {MapNode} from '@repo/apps/web/src/ui/communication-map/protocol';
import type {Traffic} from '@repo/apps/web/src/ui/communication-map/layout';
import {normalizeToViewport} from '@repo/apps/web/src/ui/communication-map/viewport-layout';
// Reserve a top band for the counter so no agent is ever drawn under it.
const hudLayout=(points:Float64Array,width:number,height:number,topInset=0)=>normalizeToViewport(points,width,height,Math.max(topInset,190));
import '@repo/apps/web/src/styles.css';
import '@repo/apps/web/src/ui/theme.css';
import '@repo/apps/web/src/ui/project-communication.css';
import './timelapse.css';

// Synthetic swarm: every pixel of the map is the production CommunicationMap; only the data is invented.
const params=new URLSearchParams(location.search);
const SCHEDULE=(params.get('schedule')??'2,3,4,6,8,11,14,18,23,29,36,44,53,64').split(',').map(Number);
const TICK=Number(params.get('tick')??1600),INTRO=1200,OUTRO=Number(params.get('outro')??5000);
const MAX=SCHEDULE.at(-1)!,END=INTRO+SCHEDULE.length*TICK,TOTAL=END+OUTRO,BASE=Date.UTC(2026,10,15,12);

function rng(seed:number){return()=>{seed|=0;seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
const random=rng(42),pick=<T,>(list:readonly T[])=>list[Math.floor(random()*list.length)];
const families=['claude','codex','opus','sonnet'],roles=['scout','builder','reviewer','tester','planner','writer','researcher','fixer','designer','integrator'];
const focuses=['Building the shared components','Reviewing a pull request','Writing the test plan','Researching the API','Fixing the layout','Planning the next milestone'];
const characters=['person-01','person-02','person-03','person-04','person-robot','person-alien'] as const;

// When each agent joins, and who owns it. New people arrive as the swarm grows.
const joinAt=Array.from({length:MAX},(_,i)=>INTRO+SCHEDULE.findIndex(n=>n>i)*TICK);
const owners:number[]=[];let ownerCount=0;
for(let i=0;i<MAX;i++){const want=Math.min(9,1+Math.floor(i/14));if(i===0||want>ownerCount){owners.push(ownerCount);ownerCount++;}else owners.push(random()<.45?ownerCount-1:Math.floor(random()*ownerCount));}
const personJoin=[0];
const group=new Map(Array.from({length:MAX},(_,i)=>[`agent-${i}`,owners[i]]));
const agents:MapNode[]=Array.from({length:MAX},(_,i)=>{const family=pick(families);return{id:`agent-${i}`,name:`${family}-${pick(roles)}-${i+1}`,provider:family==='codex'?'codex':'claude',ownerId:'p0',ownerName:'You'};});
const people:MapNode[]=[{id:'person:p0',personId:'p0',character:characters[0],name:'You',ownerId:'p0',ownerName:'You'}];

// Message stream within the server's per-agent limits (apps/server/src/config.ts V2_LIMITS):
// at most 60 direct sends an hour (one a minute on average) and at least 5 s between sends.
// Each agent introduces itself when it starts, then sends about once a minute at random; you steer at a human pace.
const SEND_MEAN=60_000,SEND_GAP=5_000,HOURLY=60,STEER_MEAN=10_000;
const traffic:Traffic[]=[];
{let seq=0;const send=(from:string,to:string,t:number)=>traffic.push({id:`m${seq++}`,agentId:from,to:[to],audience:'direct',createdAt:BASE+t});
 const presentAt=(t:number)=>agents.filter((_,i)=>joinAt[i]<=t);
 const target=(i:number,t:number)=>{const present=presentAt(t).filter(a=>a!==agents[i]);if(!present.length)return null;const team=present.filter(a=>group.get(a.id)===group.get(agents[i].id));return random()<.8&&team.length?pick(team):pick(present);};
 for(let i=0;i<MAX;i++){const sends:number[]=[];let t=joinAt[i]+500+random()*2500;
  while(t<TOTAL){const to=target(i,t);if(to&&sends.length<HOURLY){send(agents[i].id,to.id,t);sends.push(t);}
   t+=Math.max(SEND_GAP,-Math.log(1-random())*SEND_MEAN);}}
 for(let t=2000+random()*STEER_MEAN;t<TOTAL;t+=Math.max(3000,-Math.log(1-random())*STEER_MEAN)){const present=presentAt(t);if(present.length)send('person:p0',pick(present).id,t);}
 traffic.sort((a,b)=>a.createdAt-b.createdAt);}

export default function Timelapse(){
 const [elapsed,setElapsed]=useState(0);
 useEffect(()=>{const start=performance.now();const timer=setInterval(()=>setElapsed(Math.min(TOTAL,performance.now()-start)),50);(window as any).__timelapse={total:TOTAL};return()=>clearInterval(timer);},[]);
 const tick=Math.max(0,Math.min(SCHEDULE.length-1,Math.floor((elapsed-INTRO)/TICK)));
 const count=elapsed<INTRO?SCHEDULE[0]:SCHEDULE[tick];
 const peopleShown=people.filter((_,k)=>personJoin[k]<=Math.max(elapsed,INTRO));
 const nodes=useMemo(()=>[...agents.slice(0,count),...peopleShown],[count,peopleShown.length]);
 const ids=useMemo(()=>new Set(nodes.map(n=>n.id)),[nodes]);
 const shownTraffic=useMemo(()=>traffic.filter(m=>ids.has(m.agentId)&&m.to.every(id=>ids.has(id))),[ids]);
 const at=BASE+elapsed;
 const observations=useMemo(()=>new Map<string,CommunicationAgent>(agents.slice(0,count).map((a,i)=>[a.id,{id:a.id,name:a.name!,mine:false,state:(['working','working','working','idle','waiting','working','needs_you','working'] as const)[(i*5+Math.floor(elapsed/4000))%8],focus:{text:focuses[i%focuses.length],updatedAt:at},reportedAt:at,lastContactAt:at,freshUntil:null}])),[count,Math.floor(elapsed/1000)]);
 const sent=useMemo(()=>shownTraffic.filter(m=>m.createdAt<=at).length,[shownTraffic,Math.floor(elapsed/100)]);
 const outro=Math.max(0,Math.min(1,(elapsed-END-800)/900));
 return <div className="tl" style={{'--outro':outro} as CSSProperties}>
  <div className="tl-map"><CommunicationMap viewportLayout={hudLayout} crowding="focus-active" nodes={nodes} traffic={shownTraffic} at={at} now={at} running active replay={false} simulatedStates speed={1} observations={observations} selected={null} inspected={null} tooltipId="tl-tip" onInspect={()=>{}} onLeave={()=>{}} onDismiss={()=>{}} onSelect={()=>{}} onEdge={()=>{}}/></div>
  <header className="tl-hud">
   <div className="tl-brand">Minions</div>
   <div className="tl-count" key={count}><strong>{count}</strong><span>agents</span></div>
   <div className="tl-sub">{sent.toLocaleString('en-US')} messages</div>
  </header>
  <div className="tl-outro"><strong>Minions</strong><span>Agents collaborate. Humans guide.</span></div>
  <div className="tl-synthetic">Synthetic demo data</div>
 </div>;
}
