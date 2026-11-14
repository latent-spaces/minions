import {stableHash} from './avatar-tone.js';

export function ambientTiming(id:string) {
  const hash=stableHash(`character-ambient:${id}`),gazeDuration=10_000+(hash>>>8)%5001;
  // Keep the glance length; a longer start interval gives 15% fewer episodes.
  return {gazeInterval:Math.round((gazeDuration+2000)/.85),gazeDelay:2000+(hash>>>5)%3001,gazeDuration};
}
/** Gaze follows the pointer only when an agent is not busy: a working or talking agent keeps its own motion (owner, 14 November 2026). */
export const GAZE_STATES:readonly string[]=['idle','waiting','completed'];
/** Gaze is occasional; wild reactions now come from pokes, never an autonomous timer. */
export class CharacterAmbient {
  private nextGaze:number;
  private began=-Infinity;
  private hadPointer=false;
  constructor(now:number,private timing=ambientTiming('default')){this.nextGaze=now+timing.gazeDelay;}
  sample(now:number,available:boolean,pointer:boolean,canStart=true):{kind:'none'|'gaze';amount?:number} {
    if(!available){this.began=-Infinity;this.hadPointer=false;this.nextGaze=Math.max(this.nextGaze,now+this.timing.gazeDelay);return {kind:'none'};}
    if(!pointer){this.hadPointer=false;this.began=-Infinity;return {kind:'none'};}
    if(!this.hadPointer){this.hadPointer=true;this.nextGaze=Math.max(this.nextGaze,now+this.timing.gazeDelay);}
    if(canStart&&now>=this.nextGaze){this.began=now;this.nextGaze=now+Math.max(this.timing.gazeInterval,this.timing.gazeDuration+2000);}
    const elapsed=now-this.began;
    return elapsed<this.timing.gazeDuration?{kind:'gaze',amount:Math.max(0,Math.min(1,elapsed/240,(this.timing.gazeDuration-elapsed)/240))}:{kind:'none'};
  }
}

// Direction sector selection adapted from page-mascot, Copyright (c) 2026 Kamran Ahmed.
// MIT license: ./licenses/page-mascot.txt, upstream 76a44ed9180063bf4852b9dd724b656f4a828ac7.
const sectors=[5,8,7,6,3,0,1,2],sectorAngle=Math.PI/4;
export function gazeCell(dx:number,dy:number,previous=-1):{cell:number;sector:number} {
  if(Math.hypot(dx,dy)<70)return {cell:4,sector:-1};
  const angle=Math.atan2(dy,dx),wrap=(a:number)=>Math.atan2(Math.sin(a),Math.cos(a));
  const held=previous>=0&&previous<8&&Math.abs(wrap(angle-previous*sectorAngle))<sectorAngle/2+.12;
  const sector=held?previous:(Math.round(angle/sectorAngle)+8)%8;
  return {cell:sectors[sector],sector};
}

let pointer:{x:number;y:number}|null=null;
const pointerListeners=new Set<()=>void>();
let pointerFrame=0;
const publishPointer=()=>{if(!pointerFrame)pointerFrame=requestAnimationFrame(()=>{pointerFrame=0;pointerListeners.forEach(listener=>listener());});};
const move=(event:MouseEvent)=>{if('pointerType' in event&&event.pointerType==='touch')return;pointer={x:event.clientX,y:event.clientY};publishPointer();};
const leave=()=>{pointer=null;publishPointer();};
export function subscribeCharacterPointer(listener:()=>void) {
  pointerListeners.add(listener);
  if(pointerListeners.size===1){window.addEventListener('pointermove',move,{passive:true});window.addEventListener('mousemove',move,{passive:true});window.addEventListener('pointerdown',move,{passive:true});document.documentElement.addEventListener('pointerleave',leave);window.addEventListener('blur',leave);}
  return()=>{pointerListeners.delete(listener);if(!pointerListeners.size){window.removeEventListener('pointermove',move);window.removeEventListener('mousemove',move);window.removeEventListener('pointerdown',move);document.documentElement.removeEventListener('pointerleave',leave);window.removeEventListener('blur',leave);pointer=null;cancelAnimationFrame(pointerFrame);pointerFrame=0;}};
}
export const characterPointer=()=>pointer;
