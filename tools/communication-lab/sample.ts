import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import type {CommunicationAgent} from '@mlswarm/contracts';
import type {MapNode} from '../../apps/web/src/ui/communication-map/protocol';
import type {Traffic} from '../../apps/web/src/ui/communication-map/layout';
const names=['sonnet-stars-2','claude-scout','codex-tooling','opus-strategist','sonnet-stars-1','codex-integration','claude-builder','opus-reviewer'];
const focuses=['Building the shared components','Reviewing the map layout','Rebasing the project branch','Checking the phone experience'];
export const sampleCount=9;
export const sampleNodes:MapNode[]=Array.from({length:sampleCount},(_,i)=>i===0?{id:'person:demo',personId:'demo',character:'person-03',name:'Sample person',ownerId:'demo',ownerName:'Sample person'}:{id:`lab-agent-${i}`,name:names[i-1],ownerId:'demo',ownerName:'Sample person'});
export type SampleMessage=Traffic & {id:string;body:string};
export type Snapshot={at:number;playing:boolean;messages:SampleMessage[]};
export function useSample(enabled:boolean){
 const [at,setAt]=useState(Date.now),[playing,setPlaying]=useState(true);
 const [messages,setMessages]=useState<SampleMessage[]>(()=>sampleNodes.slice(1).map((node,i)=>({id:`sample-${i}`,agentId:sampleNodes[i].id,to:[node.id],audience:'direct',createdAt:at-5000-i*500,body:`Synthetic message: ${node.name}, please review ${focuses[i%focuses.length].toLowerCase()}.`})));
 const clock=useRef(at),sequence=useRef(0);clock.current=at;
 const send=useCallback(()=>{const number=++sequence.current,i=1+(number-1)%8,createdAt=clock.current+1;clock.current=createdAt;setAt(createdAt);setMessages(rows=>[...rows.slice(-63),{id:`new-${number}`,agentId:sampleNodes[i].id,to:[sampleNodes[i===8?1:i+1].id],audience:'direct',createdAt,body:`Sample message ${number}: ${focuses[(number-1)%4]}. Please check the result and share your findings.`}]);},[]);
 useEffect(()=>{if(!enabled||!playing)return;let previous=performance.now();const timer=setInterval(()=>{const now=performance.now();if(!document.hidden)setAt(value=>value+Math.min(200,now-previous));previous=now;},100);return()=>clearInterval(timer);},[enabled,playing]);
 useEffect(()=>{if(!enabled||!playing)return;const timer=setInterval(send,4000);return()=>clearInterval(timer);},[enabled,playing,send]);
 const receive=useCallback((snapshot:Snapshot)=>{setAt(snapshot.at);setPlaying(snapshot.playing);setMessages(snapshot.messages);},[]);
 const observations=useMemo(()=>new Map<string,CommunicationAgent>(sampleNodes.slice(1).map((node,i)=>[node.id,{id:node.id,name:node.name!,mine:true,state:(['working','idle','working','needs_you','working','waiting','blocked','working'] as const)[i],focus:{text:focuses[i%4],updatedAt:at},reportedAt:at,lastContactAt:at,freshUntil:null}])),[at]);
 return {at,playing,messages,observations,send,setPlaying,receive};
}
