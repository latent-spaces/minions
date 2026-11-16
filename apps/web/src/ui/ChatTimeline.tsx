import { Children, isValidElement, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, Copy } from './icons';
import { clipText } from './message-preview';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button } from './Button';
import './chat.css';

type Entry = { id: string; createdAt: number; body: string; summary?: string | null };
const day = (at: number) => new Date(at).toLocaleDateString([], {year:'numeric',month:'short',day:'numeric'});
function Code({body,language}: {body:string;language:string}) {
  const [state,setState]=useState('Copy code');
  async function copy() {
    try { await navigator.clipboard.writeText(body);setState('Copied'); }
    catch { setState('Copy unavailable'); }
  }
  return <div className="k42-chat-code"><div><span>{language || 'Code'}</span><Button className="soft" type="button" onClick={() => { void copy(); }}><Copy size={14} aria-hidden="true" />{state}</Button></div><pre tabIndex={0} aria-label={language?`${language} code`:'Code'}><code>{body}</code></pre><span className="visually-hidden" role="status">{state==='Copy code'?'':state}</span></div>;
}
function chatUrl(url: string): string | undefined {
  try { const parsed = new URL(url);return parsed.protocol==='https:'||parsed.protocol==='http:'?parsed.href:undefined; }
  catch { return undefined; }
}
const markdownComponents: Components = {
  a: ({href,children}) => href?<a href={href} target="_blank" rel="noopener noreferrer">{children}</a>:<span>{children}</span>,
  // Images in messages never contact a remote host until the reader opens one.
  img: ({src,alt}) => typeof src==='string'?<a href={src} target="_blank" rel="noopener noreferrer">{alt||'Image'} (open image)</a>:<span>{alt||'Image unavailable'}</span>,
  pre: ({children}) => {
    const code=Children.toArray(children)[0];
    if(isValidElement<{children?:ReactNode;className?:string}>(code))return <Code body={Children.toArray(code.props.children).join('').replace(/\n$/,'')} language={code.props.className?.match(/(?:^|\s)language-(\S+)/)?.[1]??''}/>;
    return <pre>{children}</pre>;
  },
  table: ({children}) => <div className="k42-chat-table" role="region" aria-label="Message table" tabIndex={0}><table>{children}</table></div>,
};
export function ChatBody({body}: {body:string}) {
  // No raw-HTML plugin: React Markdown escapes HTML as text. The URL transform
  // additionally restricts GFM links and image destinations to HTTP(S).
  return <div className="k42-chat-body"><Markdown remarkPlugins={[remarkGfm]} urlTransform={chatUrl} components={markdownComponents}>{body}</Markdown></div>;
}
export function MessageBody({body,onToggle}: {body:string;onToggle?:()=>void}) {
  const [expanded,setExpanded]=useState(false);
  const toggle=()=>{onToggle?.();setExpanded(value=>!value);};
  const long=body.length>1600||body.split('\n').length>24;
  const preview=clipText(body,1200).split('\n').slice(0,20).join('\n').trimEnd();
  return <><ChatBody body={long&&!expanded?`${preview}\n\n…`:body}/>
    {long&&<Button className="k42-chat-expand soft" type="button" aria-expanded={expanded} onClick={toggle}>{expanded?'Show less':'Show full message'}</Button>}</>;
}
export function ChatTimeline<M extends Entry>({messages,label,loading,empty,older,busy,hasOlder,renderIdentity,senderKey,pending,renderActions,renderQuote,renderAttachments,highlightMessageId,onReadLatest,fullMessages=false,isMine}: {
  isMine?:(message:M)=>boolean;
  messages:M[];label:string;loading:boolean;empty:string;older:()=>void;busy:boolean;hasOlder:boolean;
  renderIdentity:(message:M)=>ReactNode;senderKey:(message:M)=>string;pending?:ReactNode;
  renderActions?:(message:M)=>ReactNode;renderQuote?:(message:M)=>ReactNode;highlightMessageId?:string|null;
  renderAttachments?:(message:M)=>ReactNode;onReadLatest?:(through:{id:string;createdAt:number})=>void;
  fullMessages?:boolean;
}) {
  const log=useRef<HTMLDivElement>(null),content=useRef<HTMLDivElement>(null), bottom=useRef(true), initial=useRef(false);
  const anchor=useRef<{id:string;offset:number}|null>(null), previous=useRef<M[]>([]);
  const focused=useRef<string|null>(null);
  const readCallback=useRef(onReadLatest),lastMessage=useRef<M|undefined>(messages.at(-1)),readFrame=useRef<number|null>(null);
  readCallback.current=onReadLatest;lastMessage.current=messages.at(-1);
  const [unseen,setUnseen]=useState(0), [away,setAway]=useState(false);
  function reportRead() {
    if(readFrame.current!==null)cancelAnimationFrame(readFrame.current);
    readFrame.current=requestAnimationFrame(()=>{
      readFrame.current=null;
      const el=log.current,last=lastMessage.current;
      if(el&&last&&el.clientHeight>0&&document.visibilityState==='visible'&&el.scrollHeight-el.scrollTop-el.clientHeight<64){
        const rows=el.querySelectorAll<HTMLElement>('[data-chat-message]'),row=rows[rows.length-1];
        const bounds=el.getBoundingClientRect(),latestBounds=row?.getBoundingClientRect();
        // A mounted Activity preview below the fold has not been read.
        if(latestBounds&&latestBounds.bottom>Math.max(0,bounds.top)&&latestBounds.bottom<=Math.min(window.innerHeight,bounds.bottom)+2)readCallback.current?.({id:last.id,createdAt:last.createdAt});
      }
    });
  }
  function remember() {
    // Activity and the full chat stay mounted behind hidden section wrappers.
    // Their zero layout metrics must never replace the reader's saved position.
    const el=log.current;if(!el||el.clientHeight===0)return;
    bottom.current=el.scrollHeight-el.scrollTop-el.clientHeight<64;setAway(!bottom.current);
    if(bottom.current)setUnseen(0);
    const bounds=el.getBoundingClientRect();
    const row=Array.from(el.querySelectorAll<HTMLElement>('[data-chat-message]')).find(item=>item.getBoundingClientRect().bottom>bounds.top);
    anchor.current=row?{id:row.dataset.chatMessage!,offset:row.getBoundingClientRect().top-bounds.top}:null;
    reportRead();
  }
  function latest() {const el=log.current;if(!el||el.clientHeight===0)return;el.scrollTop=el.scrollHeight;bottom.current=true;setUnseen(0);setAway(false);remember();}
  function restoreAnchor() {
    const el=log.current,saved=anchor.current;if(!el||el.clientHeight===0||!saved)return;
    const row=Array.from(el.querySelectorAll<HTMLElement>('[data-chat-message]')).find(item=>item.dataset.chatMessage===saved.id);
    if(row)el.scrollTop+=row.getBoundingClientRect().top-el.getBoundingClientRect().top-saved.offset;
  }
  function beforeDisclosure(id:string) {
    const el=log.current;if(!el||!el.clientHeight)return;
    const row=Array.from(el.querySelectorAll<HTMLElement>('[data-chat-message]')).find(item=>item.dataset.chatMessage===id);
    if(row)anchor.current={id,offset:row.getBoundingClientRect().top-el.getBoundingClientRect().top};
    bottom.current=false; // A reader opening detail controls the viewport, not auto-follow.
  }
  useLayoutEffect(()=> {
    const el=log.current;if(!el||el.clientHeight===0)return;
    if (!initial.current && !loading) {initial.current=true;latest();}
    else if (bottom.current) latest();
    else {
      restoreAnchor();
      const last=previous.current.at(-1);if(last){const at=messages.findIndex(item=>item.id===last.id);if(at>=0)setUnseen(value=>value+messages.length-at-1);}
      remember();
    }
    previous.current=messages;
  },[messages,loading,pending]);
  useLayoutEffect(()=> {
    if(!content.current||typeof ResizeObserver==='undefined')return;
    const observer=new ResizeObserver(()=>{if(!log.current?.clientHeight)return;if(bottom.current)latest();else{restoreAnchor();remember();}});
    observer.observe(content.current);if(log.current)observer.observe(log.current);return()=>observer.disconnect();
  },[]);
  useLayoutEffect(()=>{
    document.addEventListener('visibilitychange',reportRead);
    window.addEventListener('scroll',reportRead,true);
    return()=>{document.removeEventListener('visibilitychange',reportRead);window.removeEventListener('scroll',reportRead,true);if(readFrame.current!==null)cancelAnimationFrame(readFrame.current);};
  },[]);
  useLayoutEffect(()=> {
    if(!highlightMessageId){focused.current=null;return;}
    if(focused.current===highlightMessageId)return;
    const el=log.current;if(!el||el.clientHeight===0)return;
    const row=Array.from(el.querySelectorAll<HTMLElement>('[data-chat-message]')).find(item=>item.dataset.chatMessage===highlightMessageId);
    if(!row)return;
    focused.current=highlightMessageId;
    el.scrollTop+=row.getBoundingClientRect().top-el.getBoundingClientRect().top-Math.max(16,(el.clientHeight-row.clientHeight)/2);
    row.querySelector<HTMLElement>('article')?.focus({preventScroll:true});remember();
  },[highlightMessageId,messages]);
  return <div className="k42-chat-timeline-wrap">
    <div ref={log} className="k42-chat-timeline" role="region" aria-label={label} tabIndex={0} onScroll={remember}>
      <div ref={content} className="k42-chat-content">
      {hasOlder && <div className="k42-chat-history"><Button className="soft" type="button" disabled={busy} onClick={older}>{busy?'Loading…':'Load older messages'}</Button></div>}
      {loading && <p className="k42-chat-empty" role="status">Loading messages…</p>}
      {!loading && messages.length===0 && <p className="k42-chat-empty">{empty}</p>}
      <ol className="k42-chat-messages">{messages.map((message,index)=> {
        const before=messages[index-1],newDay=!before || day(before.createdAt)!==day(message.createdAt);
        const grouped=before&&!newDay&&senderKey(before)===senderKey(message)&&message.createdAt-before.createdAt<5*60_000;
        return <li key={message.id} data-chat-message={message.id}>
          {newDay && <div className="k42-chat-date"><span>{day(message.createdAt)}</span></div>}
          <article tabIndex={-1} className={`k42-chat-message${grouped?' k42-chat-grouped':''}${message.id===highlightMessageId?' k42-chat-highlighted':''}${isMine?.(message)?' k42-chat-mine':''}`}>
            <header><div className="k42-chat-identity">{renderIdentity(message)}</div><span className="k42-chat-time"><time dateTime={new Date(message.createdAt).toISOString()} title={new Date(message.createdAt).toLocaleString()}>{new Date(message.createdAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</time></span></header>
            {renderQuote?.(message)}
            <>{fullMessages ? <ChatBody body={message.body}/> : <MessageBody body={message.body} onToggle={()=>beforeDisclosure(message.id)}/>}</>
            {renderAttachments?.(message)}
            {renderActions&&<footer className="k42-chat-actions">{renderActions(message)}</footer>}
          </article>
        </li>;
      })}</ol>
      {pending}
      </div>
    </div>
    {away && <Button type="button" className="k42-chat-latest" onClick={()=>{latest();log.current?.focus({preventScroll:true});}}><ArrowDown size={14} aria-hidden="true"/>{unseen?`${unseen} new ${unseen===1?'message':'messages'}`:'Latest messages'}</Button>}
    <span className="visually-hidden" role="status">{unseen?`${unseen} new messages. Use the new messages button to jump to the latest.`:''}</span>
  </div>;
}
