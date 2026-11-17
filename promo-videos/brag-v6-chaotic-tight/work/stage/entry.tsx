// Chaotic brag video. Every frame is a function of window.__T (set by the capture script; the clock is faked too).
// Real Minions components, CSS and character assets; all data is synthetic.
import {createRoot} from 'react-dom/client';
import {useEffect,useMemo,useState,type CSSProperties,type ReactNode} from 'react';
import type {CommunicationAgent,CommunicationAgentState} from '@minions/contracts';
import {CharacterAvatar} from '../../../../apps/web/src/ui/CharacterAvatar';
import {characterSource,ANIMAL_CHARACTERS} from '../../../../apps/web/src/ui/character-set';
import {CommunicationMap} from '../../../../apps/web/src/ui/communication-map/CommunicationMap';
import {normalizeToViewport} from '../../../../apps/web/src/ui/communication-map/viewport-layout';
import type {MapNode} from '../../../../apps/web/src/ui/communication-map/protocol';
import type {Traffic} from '../../../../apps/web/src/ui/communication-map/layout';
import {claudePrompt,DEFAULT_PROMPT_CHOICES} from '../../../../apps/web/src/ui/claude-prompt';
import {Check,Pause,Square} from 'lucide-react';
import '../../../../apps/web/src/styles.css';
import '../../../../apps/web/src/ui/theme.css';
import '../../../../apps/web/src/ui/application-shell.css';
import '../../../../apps/web/src/ui/project-communication.css';
import '../../../../apps/web/src/ui/project-home.css';
import '../../../../apps/web/src/ui/needs-you.css';
import './stage.css';

const B=0.4; // 150 BPM
const SQ=new URLSearchParams(location.search).get('fmt')==='square';
const W=SQ?1080:1920,H=1080,CX=W/2;
const clamp=(v:number,a=0,b=1)=>Math.min(b,Math.max(a,v));
const p=(t:number,a:number,b:number)=>clamp((t-a)/(b-a));
const out3=(x:number)=>1-Math.pow(1-x,3);
const back=(x:number)=>{const c=2.2;return 1+(c+1)*Math.pow(x-1,3)+c*Math.pow(x-1,2);};
const on=(t:number,a:number,b:number)=>t>=a&&t<b;
/** Slam: lands from `from`× scale in 0.12s. */
const slam=(t:number,a:number,from=2.6)=>{const k=out3(p(t,a,a+.12));return {scale:from+(1-from)*k,opacity:k>0?Math.min(1,k*3):0};};
/** Deterministic shake for `dur` after `a`. */
const shake=(t:number,a:number,dur=.25,amp=18)=>{const k=1-p(t,a,a+dur);if(t<a||k<=0)return '';const f=Math.floor(t*30);return `translate(${Math.sin(f*12.9898)*amp*k}px,${Math.cos(f*78.233)*amp*k}px)`;};

/** Kick envelope: 1 on each beat from `a`, decaying to 0 within the beat. */
const kick=(t:number,a:number)=>{if(t<a)return 0;const x=((t-a)%B)/B;return Math.pow(1-x,3);};
/** Hop height (0..1) on each beat from `a`. */
const hop=(t:number,a:number,phase=0)=>{if(t<a)return 0;const x=(((t-a)/B+phase)%1+1)%1;return Math.sin(Math.PI*Math.min(1,x/.6))*(x<.6?1:0);};

const TONES=['--pastel-butter','--pastel-sky','--pastel-mint','--pastel-blush','--pastel-lilac'];
function Tile({character,size,state='working',tone,style,live=true}:{character:string;size:number;state?:CommunicationAgentState;tone:string;style?:CSSProperties;live?:boolean}){
 return <div className="tile" style={{width:size,height:size,background:`var(${tone})`,...style}}>
  <div className="tile-face" data-character-motion-root="">{live?<CharacterAvatar character={character} src={characterSource(character)} state={state} animationKey={character}/>:<img src={characterSource(character)} alt=""/>}</div>
 </div>;
}
function Big({children,style,className=''}:{children:ReactNode;style?:CSSProperties;className?:string}){return <h1 className={`big ${className}`} style={style}>{children}</h1>;}
function Stamp({t,a,b,children,top=420,size=230,className='',from=2.6}:{t:number;a:number;b:number;children:ReactNode;top?:number;size?:number;className?:string;from?:number}){
 if(!on(t,a,b))return null;const s=slam(t,a,from);
 return <Big className={className} style={{top,fontSize:size,opacity:s.opacity,transform:`${shake(t,a+.1)} scale(${s.scale})`}}>{children}</Big>;
}

// 1 · hook
function Hook({t}:{t:number}){
 const pop=back(p(t,0,.25));
 return <div className="layer ink">
  <Tile character="fox" size={380} state={t<.8?'idle':'working'} tone="--pastel-butter" style={{left:CX,top:SQ?640:700,transform:`translate(-50%,-50%) scale(${pop}) rotate(${t>=.8?-6:0}deg)`}}/>
  <Stamp t={t} a={0} b={.8} top={110} size={SQ?130:210} from={1.6}>ONE AGENT?</Stamp>
  <Stamp t={t} a={.8} b={1.6} top={110} size={260} className="accent">CUTE.</Stamp>
 </div>;
}

// 2 · multiply
const GRIDS:[number,number,number][]=SQ?[[1.6,2,2],[2.0,3,3],[2.4,6,6],[2.8,12,12]]:[[1.6,2,1],[2.0,4,2],[2.4,8,4],[2.8,16,8]];
function Multiply({t}:{t:number}){
 const step=[...GRIDS].reverse().find(g=>t>=g[0])!;const [a,cols,rows]=step;const idx=GRIDS.indexOf(step);
 const cell=Math.min(W/cols,H/rows),size=cell*.86;
 const bg=['#FDF0C4','#DCEBFB','#DDF2E6','#ECE3FA'][idx];
 const k=out3(p(t,a,a+.15)),z=1.25-.25*k;
 const words=['MORE.','MORE.','MORE.','WAY MORE.'];
 return <div className="layer" style={{background:bg}}>
  <div className="layer" style={{transform:`scale(${z})`}}>
   {Array.from({length:cols*rows},(_,i)=>{const c=i%cols,r=Math.floor(i/cols);const ch=ANIMAL_CHARACTERS[(i*5+idx)%ANIMAL_CHARACTERS.length];
    return <Tile key={`${idx}-${i}`} live={cols<=4} character={ch} size={size} tone={TONES[(i+idx)%TONES.length]} style={{left:W/2+(c-(cols-1)/2)*cell,top:H/2+(r-(rows-1)/2)*cell,transform:`translate(-50%,-50%) rotate(${((i*37)%11-5)*k}deg)`}}/>;})}
  </div>
  {idx>0&&<Stamp t={t} a={a} b={a+.4} top={idx===3?(SQ?420:380):400} size={idx===3?(SQ?150:250):(SQ?220:270)} className="outline">{words[idx]}</Stamp>}
 </div>;
}

// 3 · wordmark
function Reveal({t}:{t:number}){
 const s=slam(t,3.2,3.4);
 // Keeps moving: slow push-in, a kick on every beat, a bar-line punch at 4.8 with a colour swap.
 const k=kick(t,3.6),bar=t>=4.8,push=1+.08*p(t,3.2,5.6);
 const sub=slam(t,3.6,1.8),sub2=slam(t,4.8,1.5);
 return <div className="layer" style={{background:bar?'#0066ff':'#141414'}}>
  <div className="layer" style={{transform:`scale(${push})`}}>
   <div className="mark" style={{opacity:s.opacity,transform:`${shake(t,3.3,.35,26)}${shake(t,4.8,.25,20)} scale(${s.scale*(1+.045*k)}) rotate(${bar?-2:0}deg)`}}><span className="wordmark-logo">Minions</span></div>
   {t>=3.6&&<p className="sub" style={{opacity:sub.opacity,transform:`scale(${(bar?sub2.scale:sub.scale)*(1+.03*k)})`,color:bar?'#FDF0C4':'#fff'}}>YOUR OWN LITTLE SWARM<br/>OF CODING AGENTS.</p>}
  </div>
  {ANIMAL_CHARACTERS.slice(0,8).map((c,i)=>{const at=3.6+i*.1;const kk=p(t,at,at+.18);const h=hop(t,at+.2,i%2?.5:0);return <Tile key={c} character={c} tone={TONES[i%5]} size={SQ?100:130} style={{left:SQ?80+i*131:200+i*217,top:(i%2?975:955)-h*60,opacity:kk>0?1:0,transform:`translate(-50%,-50%) scale(${back(kk)}) rotate(${(i%2?8:-8)+h*(i%2?-10:10)}deg)`}}/>;})}
 </div>;
}

// 4 · prompt
const PROMPT=claudePrompt(DEFAULT_PROMPT_CHOICES);
function Prompt({t}:{t:number}){
 const typed=PROMPT.slice(0,Math.floor(clamp((t-5.7)/.5)*PROMPT.length));
 // Push-in after the prompt lands; the three agents pop in and hop on the beat; GO. re-punches on 7.2.
 const z=(1.15-.15*out3(p(t,5.6,5.75)))*(1+.06*p(t,6.2,7.6))*(1+.025*kick(t,6.4));
 const go=t>=7.2?slam(t,7.2,1.5):slam(t,6.8);
 return <div className="layer" style={{background:t>=7.2?'#FDF0C4':'#ECE3FA'}}>
  <div className="term" style={{transform:`translate(-50%,-50%) scale(${z}) ${shake(t,6.4,.2,10)}`}}>
   <div className="term-bar"><i/><i/><i/><span>~/projects — claude</span></div>
   <div className="term-body"><p className="term-user"><span className="term-chev">&gt;</span>{typed}{t<6.3&&<span className="term-caret"/>}</p>
    {t>=6.2&&<p className="term-done"><Check size={30} strokeWidth={3}/> Project created · 3 agents started
     {(['fox','cat','frog'] as const).map((c,i)=>{const kk=p(t,6.2+i*.1,6.4+i*.1);const h=hop(t,6.6,i*.33);return <Tile key={c} character={c} size={64} tone={TONES[i]} style={{position:'relative',marginLeft:i?4:18,opacity:kk>0?1:0,transform:`translateY(${-h*16}px) scale(${back(kk)})`}}/>;})}
    </p>}</div>
  </div>
  <Stamp t={t} a={6.4} b={7.6} top={SQ?70:90} size={SQ?160:200} className="ink-text">3 AGENTS.</Stamp>
  {on(t,6.8,7.6)&&<Big className="accent-text" style={{top:SQ?820:770,fontSize:240,opacity:go.opacity,transform:`${shake(t,6.9)}${shake(t,7.25,.2,22)} scale(${go.scale*(1+.06*kick(t,6.8))}) rotate(${t>=7.2?-4:0}deg)`}}>{t>=7.2?'GO. GO.':'GO.'}</Big>}
 </div>;
}

// 5/6 · map (iframe so the production map lays out at its own size)
function MapLayer({t}:{t:number}){
 const vis=on(t,7.6,12.0);
 // A punch on every word change, a slow push the whole time, and a stronger push once the chat is closed.
 const last=[7.6,8.4,9.2,10.0,11.0].filter(a=>t>=a).pop()??7.6;
 const punch=1.1-.1*out3(p(t,last,last+.15));
 const drift=1+.03*p(t,7.6,11.0)+.05*out3(p(t,11.0,12.0));
 return <div className="layer" style={{background:'#fff',opacity:vis?1:0}}>
  <div className="map-frame" style={{transform:`translate(-50%,-50%) scale(${punch*drift*(SQ?1.2:1.42)}) ${shake(t,last,.18,8)}`}}><iframe src="/?map=1" title="map"/></div>
 </div>;
}
function MapWords({t}:{t:number}){
 return <div className="layer">
  <Stamp t={t} a={7.6} b={8.4} top={60} size={SQ?140:190} className="tag">BUILDING.</Stamp>
  <Stamp t={t} a={8.4} b={9.2} top={60} size={SQ?140:190} className="tag">TALKING.</Stamp>
  <Stamp t={t} a={9.2} b={10.0} top={60} size={SQ?140:190} className="tag">REVIEWING.</Stamp>
 </div>;
}
function CloseChat({t}:{t:number}){
 // 10.0–10.8: a small chat window pops up in the corner (map stays visible), then slams shut at 10.8.
 const shut=p(t,10.6,10.8),pop=back(p(t,10.0,10.15));
 return <div className="layer">
  {t<10.8&&<div className="term small" style={{transform:`translate(-50%,-50%) scale(${pop}) scaleY(${1-shut}) scaleX(${1-shut*.3})`,opacity:1-shut*.5}}>
   <div className="term-bar"><i className="red"/><i/><i/><span>claude</span></div>
   <div className="term-body"><p className="term-user"><span className="term-chev">&gt;</span>/exit</p></div>
  </div>}
  <Stamp t={t} a={10.0} b={11.0} top={60} size={SQ?100:170} className="tag">CLOSE YOUR CHAT.</Stamp>
  <Stamp t={t} a={11.0} b={12.0} top={60} size={SQ?100:170} className="tag">THEY KEEP GOING.</Stamp>
  {t>=11.1&&<div className="live-pill" style={{transform:`translate(-50%,0) scale(${back(p(t,11.1,11.3))*(1+.04*kick(t,11.2))})`}}><span className="live-dot" style={{opacity:.4+.6*kick(t,11.2)}}/>Chat closed · 6 agents still working</div>}
 </div>;
}

// 7 · needs you
function Needs({t}:{t:number}){
 const sent=t>=13.6,pulse=sent?0:.5+.5*Math.cos((t-12)/B*Math.PI*2);
 const card=slam(t,13.2,1.6);
 return <div className="layer" style={{background:sent?'#DDF2E6':`rgb(${180+pulse*40},${35+pulse*30},${24+pulse*30})`}}>
  <Tile character="dog" size={SQ?(t>=13.2?220:300):(t>=13.2?300:340)} state={sent?'working':'needs_you'} tone="--pastel-butter" style={{left:SQ?CX:960-560*out3(p(t,13.2,13.35)),top:SQ?600-270*out3(p(t,13.2,13.35)):650-50*out3(p(t,13.2,13.35)),transform:`translate(-50%,-50%) scale(${back(p(t,12,12.2))}) ${shake(t,12,.3,14)}`}}/>
  <Stamp t={t} a={12.0} b={13.2} top={SQ?90:110} size={SQ?130:150} className={SQ?'white wrap':'white'}>UNTIL THEY NEED YOU.</Stamp>
  {t>=13.2&&<div className="needs-wrap" style={{opacity:card.opacity,transform:`scale(${card.scale})`}}>
   <article className="k42-needs-item" data-waiting={sent?undefined:'true'}>
    <header className="k42-needs-who"><span><strong>sonnet-levels</strong><span className="k42-needs-arrow"> → </span><strong>You</strong></span><span className="k42-needs-meta"><span>2D game</span><time>now</time></span></header>
    <h3 className="k42-needs-question">Should level two be a cave or a sky level?</h3>
    <fieldset className="k42-needs-choices">
     <label className="k42-needs-choice"><input type="radio" readOnly checked/><span className="k42-needs-letter">A</span><span className="k42-needs-choice-text">Sky level, with moving platforms</span><Check size={16} className="k42-needs-tick"/></label>
    </fieldset>
    {sent&&<div className="k42-needs-answer"><p><strong>You answered.</strong> sonnet-levels is back to work.</p></div>}
   </article>
  </div>}
  <Stamp t={t} a={13.6} b={14.4} top={SQ?50:70} size={SQ?120:170} className="ink-text">ANSWER. DONE.</Stamp>
 </div>;
}

// 8 · control
function Control({t}:{t:number}){
 // One trio, one style: the same white pill slams in on ink, red and blue, with a beat kick while it holds.
 const bg=t<15.2?'#141414':t<15.6?'#e5484d':'#0066ff';
 const btn=(a:number,b:number,icon:ReactNode,label:string,amp=18)=>on(t,a,b)&&<div className="ctl-btn" style={{transform:`translate(-50%,-50%) ${shake(t,a+.1,.25,amp)} scale(${slam(t,a).scale*(1+.05*kick(t,a+B))}) rotate(${(1-out3(p(t,a,a+.2)))*-8}deg)`}}>{icon}{label}</div>;
 return <div className="layer" style={{background:bg}}>
  {btn(14.4,15.2,<Pause size={SQ?84:120} strokeWidth={3}/>,'PAUSE.')}
  {btn(15.2,15.6,<Square size={SQ?76:104} strokeWidth={3} fill="currentColor"/>,'KILL.',30)}
  {btn(15.6,16.4,<Check size={SQ?84:120} strokeWidth={3.5}/>,'YOUR CALL.')}
 </div>;
}

// 9 · outro
function Outro({t}:{t:number}){
 // Characters rain in, then keep hopping on the beat; everything settles for a still poster from 19.2.
 const s=slam(t,16.4,2.2),settle=1-p(t,18.6,19.2),k=kick(t,16.8)*settle;
 return <div className="layer ink">
  {ANIMAL_CHARACTERS.map((c,i)=>{const at=16.4+(i%6)*.2,fall=out3(p(t,at,at+.35));const x=SQ?115+(i%6)*170:110+i*154,y0=-200,y1=SQ?840+Math.floor(i/6)*125+((i*53)%3)*12:930+((i*53)%3)*30;
   const h=hop(t,at+.4,(i%4)*.25)*settle;
   return <Tile key={c} character={c} size={SQ?110:120} tone={TONES[i%5]} style={{left:x,top:y0+(y1-y0)*fall-h*70,transform:`translate(-50%,-50%) rotate(${((i*29)%21-10)+h*((i%2)?14:-14)}deg)`}}/>;})}
  <div className="mark outro" style={{opacity:s.opacity,transform:`${shake(t,16.5,.3,20)} scale(${s.scale*(1+.035*k)})`}}><span className="wordmark-logo">Minions</span></div>
  <p className="sub outro" style={{opacity:t>=16.8?1:0,transform:`scale(${slam(t,16.8,1.6).scale})`}}>RUNS ON YOUR COMPUTER.</p>
  <div className="pill" style={{opacity:t>=17.2?1:0,transform:`translate(-50%,0) scale(${back(p(t,17.2,17.4))*(1+.04*k)})`}}><code>npm run setup</code></div>
  <p className="url" style={{opacity:t>=17.6?1:0,transform:`translateY(${(1-out3(p(t,17.6,17.8)))*30}px)`}}>github.com/latent-spaces/minions</p>
 </div>;
}

// Map data: busy traffic for the chaotic cut.
const BASE=Date.UTC(2026,10,16,12,0,0);
const AGENTS=[{id:'a-claude-builder',name:'claude-builder'},{id:'a-codex-tooling',name:'codex-tooling'},{id:'a-opus-reviewer',name:'opus-reviewer'},{id:'a-sonnet-levels',name:'sonnet-levels'},{id:'a-claude-art',name:'claude-art'},{id:'a-codex-tests',name:'codex-tests'}];
const NODES:MapNode[]=[{id:'person:me',personId:'me',character:'person-02',name:'You',ownerId:'me',ownerName:'You'},...AGENTS.map(a=>({id:a.id,name:a.name,ownerId:'me',ownerName:'You'}))];
const FOCUS=['Controller','Asset pipeline','Physics review','Level two','Sprite sheet','Collision tests'];
const PAIRS:[number,number][]=[[0,1],[1,2],[3,4],[2,5],[4,5],[0,3],[1,0],[5,3],[2,1],[3,0],[5,4],[5,2]];
const TRAFFIC:Traffic[]=Array.from({length:120},(_,k)=>{const [a,b]=PAIRS[k%PAIRS.length];const me=k%6===2;return {agentId:me?'person:me':AGENTS[a].id,to:[me?AGENTS[k%2?0:3].id:AGENTS[b].id],audience:'direct',createdAt:BASE+(k-20)*200};});
function MapView({t}:{t:number}){
 const now=BASE+t*1000;
 const traffic=useMemo(()=>TRAFFIC.filter(m=>m.createdAt<=now),[Math.floor(t*10)]);
 const observations=useMemo(()=>new Map<string,CommunicationAgent>(AGENTS.map((a,i)=>[a.id,{id:a.id,name:a.name,mine:true,state:'working' as CommunicationAgentState,focus:{text:FOCUS[i],updatedAt:now},reportedAt:now,lastContactAt:now,freshUntil:null}])),[Math.floor(t)]);
 return <section className="k42-swarm-panel k42-communication is-expanded"><div className="k42-communication-body"><div className="k42-communication-network"><div className="k42-communication-graph"><div className="k42-communication-map-stage">
  <CommunicationMap labelMode="full" personScale={1.25} viewportLayout={normalizeToViewport} controlsSlot={null} toolbarStart={null} crowding="focus-active" nodes={NODES} traffic={traffic} at={now} now={now} running active replay={false} simulatedStates speed={1} observations={observations} selected={null} inspected={null} tooltipId="tip" onInspect={()=>{}} onLeave={()=>{}} onDismiss={()=>{}} onSelect={()=>{}} onEdge={()=>{}}/>
 </div></div></div></div></section>;
}

function useT(read:()=>number){const [t,setT]=useState(0);useEffect(()=>{let r=0;const loop=()=>{setT(read());r=requestAnimationFrame(loop);};r=requestAnimationFrame(loop);return()=>cancelAnimationFrame(r);},[]);return t;}
const own=()=>Number((window as unknown as {__T?:number}).__T??0);
function Video(){
 const t=useT(own);
 (window as unknown as {__t:number}).__t=t;
 // A two-frame white flash on each hard cut.
 const cuts=[1.6,3.2,5.6,7.6,12.0,14.4,16.4];
 const flash=cuts.some(c=>t>=c&&t<c+2/30);
 return <div className={`stage${SQ?' sq':''}`}>
  <MapLayer t={t}/>
  {t<1.6&&<Hook t={t}/>}
  {on(t,1.6,3.2)&&<Multiply t={t}/>}
  {on(t,3.2,5.6)&&<Reveal t={t}/>}
  {on(t,5.6,7.6)&&<Prompt t={t}/>}
  {on(t,7.6,10.0)&&<MapWords t={t}/>}
  {on(t,10.0,12.0)&&<CloseChat t={t}/>}
  {on(t,12.0,14.4)&&<Needs t={t}/>}
  {on(t,14.4,16.4)&&<Control t={t}/>}
  {t>=16.4&&<Outro t={t}/>}
  {flash&&<div className="layer" style={{background:'#fff'}}/>}
 </div>;
}
function MapOnly(){const t=useT(()=>Number((parent as unknown as {__T?:number}).__T??0));return <div className="map-only-root"><MapView t={t}/></div>;}
createRoot(document.getElementById('root')!).render(new URLSearchParams(location.search).has('map')?<MapOnly/>:<Video/>);
