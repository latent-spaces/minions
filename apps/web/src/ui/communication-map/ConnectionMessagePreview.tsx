import { useEffect, useState } from 'react';
import { connectionExcerpt } from './connection-presentation';

/** The caller supplies its existing authorized reader; message bodies never enter layout workers. */
export function ConnectionMessagePreview({messageId,loadMessage,href,onOpen}: {
  messageId:string;loadMessage:(id:string)=>Promise<string>;href:string;onOpen:()=>void;
}) {
  const [body,setBody]=useState<string|null>(null),[failed,setFailed]=useState(false);
  useEffect(()=>{
    let cancelled=false;setBody(null);setFailed(false);
    loadMessage(messageId).then(value=>{if(!cancelled)setBody(value);},()=>{if(!cancelled)setFailed(true);});
    return()=>{cancelled=true;};
  },[messageId,loadMessage]);
  return <>
    <small>Latest message</small>
    <p className="k42-connection-excerpt" dir="auto">{failed?'Message preview unavailable.':body===null?'Loading message…':connectionExcerpt(body)||'No text in this message.'}</p>
    <a href={href} onClick={event=>{if(event.button===0&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey){event.preventDefault();onOpen();}}}>Open conversation →</a>
  </>;
}
