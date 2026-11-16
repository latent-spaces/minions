import { messagePreview } from './message-preview';
import { useEffect, useId, useRef, useState } from 'react';
import type { SessionUser } from '../session-identity';
import { SearchX } from './icons';
import { chatRequest, type ChatPointer } from '../chat-api';
import { Button } from './Button';
import { SearchField } from './SearchField';
import { EmptyState } from './EmptyState';
import { createChatReadQueue } from '../chat-read-queue.js';
export function ChatSearch<M extends {id:string;body:string;summary?:string|null;createdAt:number}>({search,onSelect,titleOnly=false}:{titleOnly?:boolean;search:(query:string,cursor:string|null)=>Promise<{messages:M[];next:string|null;scanned:number}>;onSelect:(message:M)=>void}) {
  const id=useId(),[query,setQuery]=useState(''),[results,setResults]=useState<M[]|null>(null),[next,setNext]=useState<string|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const live=useRef(0);useEffect(()=>()=>{++live.current;},[]);
  async function run(cursor:string|null){if(!query.trim()||busy)return;const at=++live.current;setBusy(true);setError('');try{const data=await search(query.trim(),cursor);if(at===live.current){setResults(previous=>[...new Map([...(cursor?previous??[]:[]),...data.messages].map(message=>[message.id,message])).values()].sort((a,b)=>b.createdAt-a.createdAt||(a.id<b.id?1:-1)));setNext(data.next);}}catch(e){if(at===live.current){setResults(null);setNext(null);setError(e instanceof Error?e.message:'Search failed.');}}finally{if(at===live.current)setBusy(false);}}
  // An always-visible search field like every other search; Enter searches the history (owner, 16 November 2026).
  return <div className="k42-chat-search"><div><form role="search" onSubmit={e=>{e.preventDefault();void run(null);}}><SearchField id={id} label="Search message history" placeholder="Search messages…" maxLength={100} value={query} onChange={e=>{++live.current;setBusy(false);setQuery(e.target.value);setResults(null);setNext(null);}}/></form>{error&&<p className="error" role="alert">{error}</p>}{results&&<><p role="status" className={results.length||next?undefined:'visually-hidden'}>{results.length} {results.length===1?'match':'matches'} · Newest first{next?' · More history remains to search.':''}</p>{results.length?<ol>{results.map(message=><li key={message.id}><Button className="soft" type="button" onClick={()=>onSelect(message)}><time>{new Date(message.createdAt).toLocaleString()}</time><span>{titleOnly?messagePreview(message.body,message.summary):message.body.slice(0,220)||'Attachment'}</span></Button></li>)}</ol>:!busy&&<EmptyState icon={SearchX} title="No matches." size="compact">Try another word, or fewer of them.</EmptyState>}{next&&<Button className="soft" type="button" disabled={busy} onClick={()=>void run(next)}>{busy?'Searching…':'Search older history'}</Button>}</>}</div></div>;
}
export function useChatUnread(user:SessionUser|null,projectId:string,active:boolean,threadId?:string) {
  const [count,setCount]=useState(0),[error,setError]=useState(''),[revision,setRevision]=useState(0),live=useRef(true),readEpoch=useRef(0);
  useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
  useEffect(()=>{if(!user||!active)return;let current=true,busy=false;const load=async()=>{if(busy||document.visibilityState!=='visible')return;busy=true;const at=readEpoch.current;try{const data=await chatRequest<{human:{count:number};agents:{threadId:string;count:number}[]}>(user,projectId,'/unread'+(threadId?'?threads='+encodeURIComponent(threadId):''));if(current&&at===readEpoch.current){setCount(threadId?data.agents.find(t=>t.threadId===threadId)?.count??0:data.human.count);setError('');}}catch{if(current)setError('Unread status unavailable.');}finally{busy=false;}};void load();const timer=setInterval(()=>void load(),10000);return()=>{current=false;clearInterval(timer);};},[user,projectId,active,threadId,revision]);
  const identity=`${user?.uid}:${projectId}:${threadId??'human'}`,context=useRef(identity);context.current=identity;
  const activeRef=useRef(active);activeRef.current=active;
  const queue=useRef<{identity:string;marker:ReturnType<typeof createChatReadQueue>}|null>(null);
  useEffect(()=>()=>{queue.current?.marker.dispose();queue.current=null;},[identity,active]);
  function mark(through:ChatPointer){
    if(!user||!active||document.visibilityState!=='visible')return;
    if(queue.current?.identity!==identity){
      queue.current?.marker.dispose();const at=identity;
      queue.current={identity,marker:createChatReadQueue(async pointer=>{await chatRequest(user,projectId,'/read',{channel:threadId?'agent':'human',...(threadId?{threadId}:{}),through:pointer});},{
        isCurrent:()=>live.current&&activeRef.current&&context.current===at,
        confirmed:()=>{++readEpoch.current;setCount(0);setError('');},
        failed:()=>setError('Could not save your read position.'),
      })};
    }
    queue.current.marker.observe(through);
  }
  return{count,error,mark,refresh:()=>setRevision(r=>r+1)};
}
export function LinkedChatMessage<M extends {id:string;body:string;createdAt:number}>({messageId,load,render,clear}:{messageId?:string;load:(id:string)=>Promise<M>;render:(message:M)=>React.ReactNode;clear:()=>void}) {
  const [item,setItem]=useState<{id:string;message:M}|null>(null),[error,setError]=useState('');
  useEffect(()=>{if(!messageId){setItem(null);setError('');return;}let current=true,busy=false;setItem(null);setError('');const refresh=()=>{if(busy||document.visibilityState!=='visible')return;busy=true;void load(messageId).then(message=>{if(current){setItem({id:messageId,message});setError('');}},e=>{if(current){setItem(null);setError(e instanceof Error?e.message:'This message is unavailable.');}}).finally(()=>{busy=false;});};refresh();const timer=setInterval(refresh,10000);return()=>{current=false;clearInterval(timer);};},[messageId,load]);
  if(!messageId)return null;
  return <section className="k42-chat-linked" aria-label="Linked message"><header><strong>Linked message</strong><Button className="soft" type="button" onClick={clear}>Close linked message</Button></header>{error?<p className="error" role="alert">{error}</p>:item?.id===messageId?render(item.message):<p role="status">Loading linked message…</p>}</section>;
}

export function useThreadUnreadCounts(user:SessionUser|null,projectId:string,active:boolean,threadIds:string[]) {
  const [counts,setCounts]=useState<Record<string,number>>({});const ids=threadIds.join(',');
  useEffect(()=>{if(!user||!active||!ids)return;let current=true,busy=false;const load=async()=>{if(busy)return;busy=true;try{const all:{threadId:string;count:number}[]=[];const list=ids.split(',');for(let index=0;index<list.length;index+=20){const data=await chatRequest<{agents:{threadId:string;count:number}[]}>(user,projectId,'/unread?threads='+encodeURIComponent(list.slice(index,index+20).join(',')));if(!current)return;all.push(...data.agents);}if(current)setCounts(Object.fromEntries(all.map(item=>[item.threadId,item.count])));}catch{if(current)setCounts({});}finally{busy=false;}};void load();const timer=setInterval(()=>void load(),10000);return()=>{current=false;clearInterval(timer);};},[user,projectId,active,ids]);return counts;
}
