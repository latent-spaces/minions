import {useContext,useEffect,useLayoutEffect,useRef,useState,useSyncExternalStore} from 'react';
import type {CommunicationAgentState} from '@minions/contracts';
import {CharacterMotion,characterTiming,neutralPose,staticCharacterPose,type CharacterPose,type PoseBank} from './character-motion';
import {CharacterAmbient,GAZE_STATES,ambientTiming,characterPointer,gazeCell,subscribeCharacterPointer} from './character-ambient';
import {CharacterPoke,choosePoke,POKE_WEIGHTS,rarePokeGate,SQUASH,SQUASH_MS,type PokeReaction} from './character-poke';
import {characterAtlas,useDecodedAtlas} from './character-assets';
import {CharacterPreview} from './character-preview';
import './character-avatar.css';

const listeners=new Set<()=>void>();
let clock=0,request=0,published=0;
const tick=(time:number)=>{if(time-published>=40){clock=time;published=time;listeners.forEach(listener=>listener());}if(listeners.size)request=requestAnimationFrame(tick);};
const subscribe=(listener:()=>void)=>{listeners.add(listener);if(listeners.size===1)request=requestAnimationFrame(tick);return()=>{listeners.delete(listener);if(!listeners.size)cancelAnimationFrame(request);};};
const inactive=()=>()=>{};
const now=()=>typeof performance==='undefined'?0:performance.now();
const banks:PoseBank[]=['directions','reactions','actions'];
const isQuiet=(state:CommunicationAgentState)=>['offline','revoked','unknown'].includes(state);

/** One decoded pose bank is visible at a time. Presentation never changes worker state. */
export function CharacterAvatar({character,src,state='idle',animationKey=character,onError}:{character:string;src:string;animationKey?:string;state?:CommunicationAgentState;onError?:()=>void}) {
  const preview=useContext(CharacterPreview),element=useRef<HTMLSpanElement>(null);
  const motion=useRef(new CharacterMotion(state,now(),characterTiming(animationKey)));
  const ambient=useRef(new CharacterAmbient(now(),ambientTiming(animationKey))),poke=useRef(new CharacterPoke());
  const squash=useRef<Animation|null>(null),sector=useRef(-1),wasAvailable=useRef(false);
  const [messageUntil,setMessageUntil]=useState(-Infinity);
  const [visible,setVisible]=useState(false),[reduced,setReduced]=useState(true),[fine,setFine]=useState(false),[,redraw]=useState(0);
  const time=useSyncExternalStore(visible&&!reduced?subscribe:inactive,()=>clock,()=>0);
  const pointer=useSyncExternalStore(visible&&fine&&!reduced?subscribeCharacterPointer:inactive,characterPointer,()=>null);
  const directionSrc=characterAtlas(character,'directions'),reactionSrc=characterAtlas(character,'reactions'),actionSrc=characterAtlas(character,'actions');
  const directionsReady=useDecodedAtlas(directionSrc,visible),reactionsReady=useDecodedAtlas(reactionSrc,visible);
  const wantsActions=visible&&(now()<messageUntil||!['idle','waiting','completed','offline','revoked','unknown','stopped','paused'].includes(state));
  const actionsReady=useDecodedAtlas(actionSrc,wantsActions);
  const ready={directions:directionsReady,reactions:reactionsReady,actions:actionsReady};
  // A mounted hidden <img src> still fetches. Defer the action bank until it is
  // needed, then retain the decoded layer for subsequent work/stop handoffs.
  const sources={directions:directionSrc,reactions:reactionSrc,actions:wantsActions||actionsReady?actionSrc:undefined};
  const current=now();
  motion.current.setState(state,current);
  const base=reduced?staticCharacterPose(state):motion.current.sample(time||current,false);
  const usable=visible&&!reduced&&directionsReady&&reactionsReady&&!isQuiet(state);
  const pokeSample=usable&&base.interruptible?poke.current.sample(time||current):null;
  const canPoke=usable&&base.interruptible&&!pokeSample;
  const ambientAvailable=usable&&!pokeSample&&base.interruptible&&GAZE_STATES.includes(state);
  const scheduled=ambient.current.sample(time||current,ambientAvailable&&!preview,!!pointer,base.clip!=='blink');
  const looking=ambientAvailable&&!!pointer&&(preview==='gaze'||scheduled.kind==='gaze')&&base.clip!=='blink';
  const sampled=reduced?base:motion.current.sample(time||current,!looking&&!pokeSample);
  let shown:CharacterPose=sampled;
  let kind:string=sampled.clip;
  if(pokeSample){shown={...neutralPose(),bank:'reactions',cell:pokeSample.cell,frame:pokeSample.cell};kind=pokeSample.reaction==='rare'?'rare':'poke';}
  else if(looking){
    const box=element.current?.getBoundingClientRect();
    const result=box?gazeCell(pointer!.x-box.left-box.width/2,pointer!.y-box.top-box.height/2,sector.current):{cell:4,sector:-1};
    sector.current=result.sector;
    shown={...neutralPose(),cell:result.cell,frame:result.cell};kind='gaze';
  }else sector.current=-1;
  const shownReady=ready[shown.bank],activeBank=shownReady?shown.bank:null;

  // The optional hat-gaze lab reads this on the same head+hat motion root.
  // Clear it atomically whenever another owner takes over the face.
  useLayoutEffect(()=>{
    const root=element.current?.closest<HTMLElement>('[data-character-motion-root]');
    if(!root)return;
    if(kind==='gaze'&&activeBank==='directions'){
      root.dataset.characterGazeActive='true';root.dataset.characterGazeCell=String(shown.cell);
    }else{delete root.dataset.characterGazeActive;delete root.dataset.characterGazeCell;}
    return()=>{delete root.dataset.characterGazeActive;delete root.dataset.characterGazeCell;};
  },[kind,shown.cell,activeBank]);

  useEffect(()=>{
    const media=matchMedia('(prefers-reduced-motion: reduce)'),pointerMedia=matchMedia('(hover: hover) and (pointer: fine)');
    const preference=()=>{setReduced(media.matches);setFine(pointerMedia.matches);};preference();
    media.addEventListener('change',preference);pointerMedia.addEventListener('change',preference);
    let intersects=true;
    const visibility=()=>setVisible(intersects&&!document.hidden);
    const observer=typeof IntersectionObserver==='undefined'?null:new IntersectionObserver(entries=>{intersects=entries[0].isIntersecting;visibility();});
    if(element.current)observer?.observe(element.current);
    document.addEventListener('visibilitychange',visibility);visibility();
    return()=>{observer?.disconnect();media.removeEventListener('change',preference);pointerMedia.removeEventListener('change',preference);document.removeEventListener('visibilitychange',visibility);};
  },[]);
  useLayoutEffect(()=>{poke.current.cancel();squash.current?.cancel();redraw(n=>n+1);},[state]);
  useLayoutEffect(()=>{
    if(wasAvailable.current&&(!visible||reduced)){poke.current.cancel();squash.current?.cancel();motion.current.settle(now());sector.current=-1;}
    wasAvailable.current=visible&&!reduced;
  },[visible,reduced]);
  // Keep the latest eligibility in a ref: the DOM event is synchronous, so its
  // cancellation tells a caller whether this particular poke was accepted.
  const eligibility=useRef({canPoke,state});eligibility.current={canPoke,state};
  useEffect(()=>{
    const target=element.current;
    const receive=(event:Event)=>{
      const id=(event as CustomEvent<{id:string}>).detail?.id;
      if(id){const at=now();motion.current.message(id,at);setMessageUntil(at+640);poke.current.cancel();squash.current?.cancel();redraw(n=>n+1);}
    };
    const boop=(event:Event)=>{
      if(!eligibility.current.canPoke)return;
      const at=now(),forced=(event as CustomEvent<{reaction?:PokeReaction}>).detail?.reaction;
      let reaction=forced&&POKE_WEIGHTS.some(([id])=>id===forced)?forced:choosePoke(Math.random());
      if(reaction==='rare'&&!rarePokeGate.claim(at))reaction='surprise';
      if(!poke.current.start(at,reaction))return;
      eligibility.current.canPoke=false;motion.current.afterPoke(at);event.preventDefault();
      const root=target?.closest<HTMLElement>('[data-character-motion-root]')??target;
      squash.current?.cancel();
      if(root&&typeof root.animate==='function')squash.current=root.animate(SQUASH,{duration:SQUASH_MS,easing:'linear'});
      redraw(n=>n+1);
    };
    target?.addEventListener('character-message',receive);target?.addEventListener('character-poke',boop);
    return()=>{target?.removeEventListener('character-message',receive);target?.removeEventListener('character-poke',boop);squash.current?.cancel();};
  },[]);

  return <span className="k42-character-avatar" ref={element} data-character-avatar="" data-character={character} data-poke-available={canPoke?'true':'false'}
    data-motion={activeBank?kind:'neutral'} data-frame={activeBank?shown.cell:4} data-pose-bank={activeBank??'neutral'} aria-hidden="true">
    <span className="k42-character-stage">
      <img className="k42-character-neutral" src={src} alt="" decoding="async" onError={onError} style={{visibility:activeBank?'hidden':'visible'}}/>
      {banks.map(bank=>sources[bank]&&<span key={bank} className={`k42-character-bank k42-character-${bank}`} data-pose-layer={bank} style={{visibility:activeBank===bank?'visible':'hidden'}}>
        <img className="k42-character-atlas" src={sources[bank]} alt="" decoding="async"
          style={{transform:`translate(-${(activeBank===bank?shown.cell%3:bank==='directions'?1:0)/3*100}%, -${(activeBank===bank?Math.floor(shown.cell/3):bank==='directions'?1:0)/3*100}%)`}}/>
      </span>)}
    </span>
  </span>;
}
