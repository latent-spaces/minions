import {useEffect,useState} from 'react';
import type {PoseBank} from './character-motion';
const sources=import.meta.glob<string>('./assets/characters/offbeat/poses/*.webp',{eager:true,query:'?url',import:'default'});
export function characterAtlas(character:string,bank:PoseBank){return sources[`./assets/characters/offbeat/poses/${character}-${bank}.webp`];}
// Decoded sheets are shared between repeated instances of the same face. Keep at
// most eight unused sheets; active views retain their own references until hidden.
const decoded=new Map<string,{promise:Promise<HTMLImageElement>;users:number}>();
function acquire(src:string) {
  let asset=decoded.get(src);
  if(!asset){
    const image=new Image();
    const promise=typeof image.decode==='function'
      ?(image.src=src,image.decode().then(()=>image))
      :new Promise<HTMLImageElement>((resolve,reject)=>{image.onload=()=>resolve(image);image.onerror=reject;image.src=src;});
    asset={promise,users:0};decoded.set(src,asset);
    promise.catch(()=>{if(decoded.get(src)===asset)decoded.delete(src);});
  }
  asset.users++;
  return {promise:asset.promise,release:()=>{
    asset!.users=Math.max(0,asset!.users-1);
    const unused=[...decoded].filter(([,value])=>!value.users);
    for(const [key] of unused.slice(0,Math.max(0,unused.length-8)))decoded.delete(key);
  }};
}
export function useDecodedAtlas(src:string|undefined,active:boolean) {
  const [ready,setReady]=useState<string|null>(null);
  useEffect(()=>{
    if(!src||!active)return;
    let cancelled=false;const asset=acquire(src);
    asset.promise.then(image=>{if(!cancelled&&image.naturalWidth===960&&image.naturalHeight===960)setReady(src);},()=>{});
    return()=>{cancelled=true;asset.release();};
  },[src,active]);
  return !!src&&ready===src;
}
