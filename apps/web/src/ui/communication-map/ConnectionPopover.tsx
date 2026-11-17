import { useLayoutEffect, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export function ConnectionPopover({id,anchor,title,onKeep,onLeave,onDismiss,children}: {
  id:string;anchor:SVGGElement;title:string;onKeep:()=>void;onLeave:()=>void;onDismiss:()=>void;children:ReactNode;
}) {
  const ref=useRef<HTMLDivElement>(null),[position,setPosition]=useState<{left:number;top:number}|null>(null);
  useLayoutEffect(()=>{
    const place=()=>{
      if(!anchor.isConnected||anchor.style.display==='none'){onDismiss();return;}
      const target=anchor.getBoundingClientRect(),box=ref.current!.getBoundingClientRect();
      setPosition({left:Math.max(12,Math.min(innerWidth-box.width-12,target.left+target.width/2-box.width/2)),
        top:Math.max(12,Math.min(innerHeight-box.height-12,target.top+target.height/2+12))});
    };
    place();window.addEventListener('communication-map-tick',place);window.addEventListener('resize',place);window.addEventListener('scroll',place,true);
    const observer=new ResizeObserver(place);observer.observe(ref.current!);
    return()=>{observer.disconnect();window.removeEventListener('communication-map-tick',place);window.removeEventListener('resize',place);window.removeEventListener('scroll',place,true);};
  },[anchor,onDismiss]);
  useEffect(()=>{
    const outside=(event:PointerEvent)=>{if(!anchor.contains(event.target as Node)&&!ref.current?.contains(event.target as Node))onDismiss();};
    const key=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();anchor.focus();onDismiss();}};
    document.addEventListener('pointerdown',outside);document.addEventListener('keydown',key);
    return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',key);};
  },[anchor,onDismiss]);
  return createPortal(<div ref={ref} id={id} role="dialog" aria-label={title} className="k42-connection-popover"
    style={{...position,visibility:position?'visible':'hidden'}} onMouseEnter={onKeep} onMouseLeave={onLeave} onFocus={onKeep}
    onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget))onLeave();}}>
    <strong>{title}</strong>{children}
  </div>,anchor.closest('section[aria-modal="true"]')??document.body);
}
