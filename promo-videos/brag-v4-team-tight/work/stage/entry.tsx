// Brag video composition. Every frame is a function of performance.now(), which the capture script fakes.
// Real Minions components, CSS and character assets; all data is synthetic.
import {createRoot} from 'react-dom/client';
import {useEffect,useMemo,useState,type CSSProperties,type ReactNode} from 'react';
import type {CommunicationAgent,CommunicationAgentState} from '@minions/contracts';
import {CharacterAvatar} from '../../../../apps/web/src/ui/CharacterAvatar';
import {characterSource} from '../../../../apps/web/src/ui/character-set';
import {CommunicationMap} from '../../../../apps/web/src/ui/communication-map/CommunicationMap';
import {normalizeToViewport} from '../../../../apps/web/src/ui/communication-map/viewport-layout';
import type {MapNode} from '../../../../apps/web/src/ui/communication-map/protocol';
import type {Traffic} from '../../../../apps/web/src/ui/communication-map/layout';
import {claudePrompt,DEFAULT_PROMPT_CHOICES} from '../../../../apps/web/src/ui/claude-prompt';
import {Check,PenLine,Pause,Square} from 'lucide-react';
import '../../../../apps/web/src/styles.css';
import '../../../../apps/web/src/ui/theme.css';
import '../../../../apps/web/src/ui/application-shell.css';
import '../../../../apps/web/src/ui/project-communication.css';
import '../../../../apps/web/src/ui/project-home.css';
import '../../../../apps/web/src/ui/needs-you.css';
import './stage.css';

const clamp=(v:number,a=0,b=1)=>Math.min(b,Math.max(a,v));
const p=(t:number,a:number,b:number)=>clamp((t-a)/(b-a));
const out3=(x:number)=>1-Math.pow(1-x,3);
const back=(x:number)=>{const c=1.7;return 1+(c+1)*Math.pow(x-1,3)+c*Math.pow(x-1,2);};
/** Slow push-in so no scene ever sits still. */
const cam=(t:number,a:number,b:number,k=.06):CSSProperties=>({transform:`scale(${1+k*inOut(clamp((t-a)/(b-a)))})`,transformOrigin:'50% 45%'});
/** Little hop on every beat (120 BPM). */
const hop=(t:number,phase=0,h=14)=>-h*Math.pow(Math.abs(Math.sin(Math.PI*2*(t-phase))),6);
const inOut=(x:number)=>x<.5?4*x*x*x:1-Math.pow(-2*x+2,3)/2;
/** Fade/slide in at `a`, out at `b`. */
function show(t:number,a:number,b:number,dy=24,dur=.28,outDur=.18):CSSProperties{
 const i=out3(p(t,a,a+dur)),o=p(t,b-outDur,b);
 return {opacity:i*(1-o),transform:`translateY(${(1-i)*dy-o*12}px)`};
}

const SQ=new URLSearchParams(location.search).get('fmt')==='square';
const W=SQ?1080:1920,CX=W/2;
const TEAM=['fox','cat','frog','owl','tiger','koala','raccoon','bear'] as const;
const TONES=['--pastel-butter','--pastel-sky','--pastel-mint','--pastel-blush','--pastel-lilac'];
const START_STATE:CommunicationAgentState[]=['idle','working','working','idle','working','waiting','working','idle'];

function Tile({character,size,state='idle',tone,style}:{character:string;size:number;state?:CommunicationAgentState;tone:string;style?:CSSProperties}){
 return <div className="tile" style={{width:size,height:size,background:`var(${tone})`,...style}}>
  <div className="tile-face" data-character-motion-root=""><CharacterAvatar character={character} src={characterSource(`${character}`)} state={state} animationKey={character}/></div>
 </div>;
}

function Caption({children,style}:{children:ReactNode;style:CSSProperties}){return <h2 className="caption" style={style}>{children}</h2>;}

// ---------- Scene 1–2: hook, team, reveal ----------
function Team({t}:{t:number}){
 const n=TEAM.length,size=150,gap=SQ?36:40,cols=SQ?4:n,rowW=cols*size+(cols-1)*gap;
 // Row placement; the fox (index 0) starts alone and large in the centre.
 const down=inOut(p(t,4.0,4.45)),leave=p(t,5.3,5.55);
 const scale=1-down*(SQ?.42:.28);const rowY0=SQ?560:560,rowY1=SQ?800:790;const rowY=rowY0+down*(rowY1-rowY0);const rowGap=(size+gap)*scale;
 return <div className="layer" style={{opacity:1-leave}}>
  {TEAM.map((c,i)=>{
   const col=i%cols,row=Math.floor(i/cols),x=CX-rowW/2+col*(size+gap)+size/2,y=rowY+row*(SQ?rowGap:0);
   if(i===0){
    const m=inOut(p(t,1.85,2.25)),s0=230;
    const cx=CX+(x-CX)*m,sz=s0+(size-s0)*m;
    const cy=600+(y-600)*m+(t<1.9?hop(t,.25,34):hop(t,.25+.0,10)*p(t,2,2.3));
    const appear=back(p(t,0,.35));
    const rx=CX+(cx-CX)*scale;
    return <Tile key={c} character={c} size={sz*scale} tone={TONES[0]} state={t<2?'idle':'working'} style={{left:rx,top:cy,transform:`translate(-50%,-50%) scale(${appear})`}}/>;
   }
   const at=2.0+(i-1)*.25,k=p(t,at,at+.3);
   return <Tile key={c} character={c} size={size*scale} tone={TONES[i%TONES.length]} state={START_STATE[i]} style={{left:CX+(x-CX)*scale,top:y+hop(t,.25+i*.06,12)*p(t,at+.3,at+.6),opacity:k>0?1:0,transform:`translate(-50%,-50%) scale(${back(k)})`}}/>;
  })}
 </div>;
}

function Hook({t}:{t:number}){
 return <div className="layer">
  <Caption style={{top:230,...show(t,0,1.95,40,.35)}}>One coding agent is a chat.</Caption>
  <Caption style={{top:230,...show(t,2.05,4.0)}}>Minions gives you a team.</Caption>
  <div className="reveal" style={show(t,4.05,5.5,30,.3)}><span className="wordmark-logo big">Minions</span></div>
  <p className="tagline" style={show(t,4.2,5.5,20,.3)}>Your own little swarm of coding agents.</p>
 </div>;
}

// ---------- Scene 3: start from your chat ----------
const PROMPT=claudePrompt(DEFAULT_PROMPT_CHOICES);
function Start({t}:{t:number}){
 const typed=PROMPT.slice(0,Math.floor(clamp((t-5.85)/2.0)*PROMPT.length));
 const caret=Math.floor(t*4)%2===0&&t<7.95;
 const win=out3(p(t,5.45,5.8)),leave=p(t,9.8,10.0);
 return <div className="layer" style={{opacity:1-leave}}>
  <Caption style={{top:SQ?110:120,...show(t,5.5,9.95)}}>Start it from Claude Code or Codex.</Caption>
  <div className="term" style={{opacity:win,transform:`translate(-50%,0) translateY(${(1-win)*40}px)`}}>
   <div className="term-bar"><i/><i/><i/><span>~/projects — claude</span></div>
   <div className="term-body">
    <p className="term-user"><span className="term-chev">&gt;</span>{typed}{caret&&<span className="term-caret"/>}</p>
    <p className="term-tool" style={show(t,8.05,99,10,.2)}><span className="dot"/>minions · create_private_project <span className="muted">(“2D game”, 3 agents)</span></p>
    <div className="term-done" style={show(t,8.4,99,10,.2)}>
     <Check size={26} strokeWidth={2.5}/> <span>Project created · 3 agents started</span>
     {(['fox','cat','frog'] as const).map((c,i)=>{const k=p(t,8.5+i*.12,8.75+i*.12);return <Tile key={c} character={c} size={52} tone={TONES[i]} state="working" style={{position:'relative',transform:`translateY(${hop(t,.25+i*.08,10)*p(t,8.9,9)}px) scale(${back(k)})`,opacity:k>0?1:0}}/>;})}
    </div>
   </div>
  </div>
 </div>;
}

// ---------- Scene 4: the real map ----------
const BASE=Date.UTC(2026,10,16,12,0,0);
const me='me';
const AGENTS=[
 {id:'a-claude-builder',name:'claude-builder'},{id:'a-codex-tooling',name:'codex-tooling'},{id:'a-opus-reviewer',name:'opus-reviewer'},
 {id:'a-sonnet-levels',name:'sonnet-levels'},{id:'a-claude-art',name:'claude-art'},{id:'a-codex-tests',name:'codex-tests'},
];
const NODES:MapNode[]=[{id:'person:me',personId:me,character:'person-02',name:'You',ownerId:me,ownerName:'You'},...AGENTS.map(a=>({id:a.id,name:a.name,ownerId:me,ownerName:'You'}))];
const FOCUS=['Player code','Asset pipeline','Code review','Level design','Sprite sheet','Collision tests'];
const STATES:CommunicationAgentState[]=['working','working','working','needs_you','working','working'];
const PAIRS:[number,number][]=[[0,1],[1,2],[3,4],[2,0],[4,5],[0,3],[1,0],[5,3],[2,1],[3,0]];
const TRAFFIC:Traffic[]=Array.from({length:60},(_,k)=>{const [a,b]=PAIRS[k%PAIRS.length];const fromMe=k%5===2;const to=fromMe?AGENTS[k%2?0:3].id:AGENTS[b].id;return {agentId:fromMe?'person:me':AGENTS[a].id,to:[to],audience:'direct',createdAt:BASE+(k-14)*700};});
function MapView({t}:{t:number}){
 const now=BASE+t*1000;
 const traffic=useMemo(()=>TRAFFIC.filter(m=>m.createdAt<=now),[Math.floor(t*10)]);
 const observations=useMemo(()=>new Map<string,CommunicationAgent>(AGENTS.map((a,i)=>[a.id,{id:a.id,name:a.name,mine:true,state:i===3&&t<12.5?'working':STATES[i],focus:{text:FOCUS[i],updatedAt:now},reportedAt:now,lastContactAt:now,freshUntil:null}])),[Math.floor(t)]);
 return <section className="k42-swarm-panel k42-communication is-expanded map-only"><div className="k42-communication-body"><div className="k42-communication-network"><div className="k42-communication-graph"><div className="k42-communication-map-stage">
    <CommunicationMap labelMode="full" personScale={1.25} viewportLayout={normalizeToViewport} controlsSlot={null} toolbarStart={<span className="k42-map-counts">1 person · 6 agents · 2D game</span>} crowding="focus-active" nodes={NODES} traffic={traffic} at={now} now={now} running active replay={false} simulatedStates speed={1} observations={observations} selected={null} inspected={null} tooltipId="tip" onInspect={()=>{}} onLeave={()=>{}} onDismiss={()=>{}} onSelect={()=>{}} onEdge={()=>{}}/>
   </div></div></div></div></section>;
}
function MapScene({t}:{t:number}){
 const panel=out3(p(t,10.0,10.35)),leave=p(t,13.82,14.0);
 return <div className="layer">
  <Caption style={{top:SQ?70:96,...show(t,10.05,13.97)}}>They work in the background — and talk to each other.</Caption>
  <div className="map-panel" style={{opacity:t<9.5?0:panel*(1-leave),transform:`translate(-50%,0) translateY(${(1-panel)*40}px) scale(${SQ?1.3:1.4})`}}>
   <iframe src="/?map=1" title="map"/>
  </div>
 </div>;
}

// ---------- Scene 5: needs you ----------
function Cursor({x,y,down}:{x:number;y:number;down:boolean}){
 return <svg className="cursor" style={{left:x,top:y,transform:`scale(${down?.86:1})`}} width="52" height="62" viewBox="0 0 17 20"><path d="M1 1 L1 16 L5 12.5 L8 19 L10.5 18 L7.6 11.6 L13 11.6 Z" fill="#141414" stroke="#fff" strokeWidth="1.3" strokeLinejoin="round"/></svg>;
}
function NeedsScene({t}:{t:number}){
 const picked=t>=15.25,sent=t>=15.85;
 const enter=out3(p(t,14.0,14.35)),leave=p(t,16.82,17.0);
 // cursor path: enter → choice A → Send
 const r=(sel:string,fx:number,fy:number,fb:{x:number;y:number})=>{const el=document.querySelector(sel);if(!el)return fb;const q=el.getBoundingClientRect();return {x:q.left+q.width*fx,y:q.top+q.height*fy};};
 const a=SQ?{x:990,y:1040}:{x:1560,y:1000},b=r('.k42-needs-choice .k42-needs-choice-text',.35,.55,{x:1000,y:600}),c=r('.k42-needs-send .primary',.5,.6,{x:900,y:760});
 const m1=inOut(p(t,14.6,15.15)),m2=inOut(p(t,15.35,15.65));
 const cx=a.x+(b.x-a.x)*m1+(c.x-b.x)*m2,cy=a.y+(b.y-a.y)*m1+(c.y-b.y)*m2;
 const down=(t>15.18&&t<15.3)||(t>15.68&&t<15.8);
 return <div className="layer" style={{opacity:1-leave}}>
  <Caption style={{top:SQ?90:120,...show(t,14.05,16.97)}}>They ask when they need you.</Caption>
  <Tile character="dog" tone="--pastel-butter" state={sent?'working':'needs_you'} size={SQ?170:260} style={{left:SQ?540:470,top:(SQ?320:600)+(sent?hop(t,.25,16):0),transform:`translate(-50%,-50%) scale(${back(p(t,14.0,14.4))})`}}/>
  <div className="needs-wrap" style={{opacity:enter,transform:`translateX(${(1-enter)*50}px)`}}>
   <article className="k42-needs-item" data-waiting={sent?undefined:'true'}>
    <header className="k42-needs-who"><span><strong>sonnet-levels</strong><span className="k42-needs-arrow"> → </span><strong>You</strong></span><span className="k42-needs-meta"><span>2D game</span><time>now</time></span></header>
    <h3 className="k42-needs-question">Should level two be a cave or a sky level?</h3>
    <p className="k42-needs-detail">The tile sets for both are ready. Two agents are waiting on this.</p>
    {!sent?<form onSubmit={e=>e.preventDefault()}>
     <fieldset className="k42-needs-choices">
      <label className="k42-needs-choice"><input type="radio" name="c" readOnly checked={picked}/><span className="k42-needs-letter">A</span><span className="k42-needs-choice-text">Sky level, with moving platforms</span><Check size={16} className="k42-needs-tick"/></label>
      <label className="k42-needs-choice"><input type="radio" name="c" readOnly checked={false}/><span className="k42-needs-letter">B</span><span className="k42-needs-choice-text">Cave level, with a light mechanic</span><Check size={16} className="k42-needs-tick"/></label>
      <label className="k42-needs-choice is-own"><input type="radio" name="c" readOnly checked={false}/><span className="k42-needs-letter"><PenLine size={13}/></span><span className="k42-needs-choice-text muted">Write your own answer</span></label>
     </fieldset>
     <div className="k42-needs-send"><button className="primary" type="submit" disabled={!picked}>Send answer</button></div>
    </form>:<div className="k42-needs-answer" style={show(t,15.85,99,8,.2)}><p><strong>You answered: </strong>Sky level, with moving platforms</p><p className="muted">sonnet-levels is back to work</p></div>}
   </article>
  </div>
  <div style={{opacity:p(t,14.4,14.6)*(1-p(t,16.2,16.4))}}><Cursor x={cx} y={cy} down={down}/></div>
 </div>;
}

// ---------- Scene 6: outro ----------
function Outro({t}:{t:number}){
 return <div className="layer">
  <div className="reveal outro" style={show(t,17.0,99,30,.35)}><span className="wordmark-logo big">Minions</span></div>
  <p className="tagline outro" style={show(t,17.2,99,20,.3)}>Runs on your computer. Pause or kill any time.</p>
  <div className="outro-row">
   <span className="pill" style={show(t,17.45,99,16,.3)}><code>npm run setup</code></span>
   <span className="ctl url" style={show(t,17.6,99,16,.3)}>github.com/latent-spaces/minions</span>
  </div>
  {TEAM.map((c,i)=>{const k=p(t,17.3+i*.08,17.6+i*.08);const n=TEAM.length,s=96,g=26,w=n*s+(n-1)*g;return <Tile key={c} character={c} size={s} tone={TONES[i%TONES.length]} state={START_STATE[(i+1)%8]} style={{left:CX-w/2+i*(s+g)+s/2,top:(SQ?940:880)+hop(t,.25+i*.06,14)*(1-p(t,19.0,19.2)),opacity:k>0?1:0,transform:`translate(-50%,-50%) scale(${back(k)})`}}/>;})}
 </div>;
}

function Video(){
 const [t,setT]=useState(0);
 useEffect(()=>{let t0=performance.now();let r=0;const loop=()=>{const w=window as unknown as {__reset?:boolean};if(w.__reset){w.__reset=false;t0=performance.now();}setT(typeof (window as any).__T==='number'?(window as any).__T:(performance.now()-t0)/1000+Number(new URLSearchParams(location.search).get('t')??0));r=requestAnimationFrame(loop);};r=requestAnimationFrame(loop);return()=>cancelAnimationFrame(r);},[]);
 (window as unknown as {__t:number}).__t=t;
 return <div className={`stage${SQ?' sq':''}`}>
  <div className="layer" style={{display:t<5.6?'block':'none',...cam(t,0,5.6,.07)}}><Team t={t}/><Hook t={t}/></div>
  <div className="layer" style={{display:t>=5.4&&t<10?'block':'none',...cam(t,5.4,10,.07)}}><Start t={t}/></div>
  <div className="layer" style={cam(t,10,14,.08)}><MapScene t={t}/></div>
  <div className="layer" style={{display:t>=14&&t<17?'block':'none',...cam(t,14,17,.07)}}><NeedsScene t={t}/></div>
  <div className="layer" style={{display:t>=17?'block':'none',...cam(t,17,19.2,.05)}}><Outro t={t}/></div>
 </div>;
}
function MapOnly(){
 const [t,setT]=useState(0);
 useEffect(()=>{let r=0;const loop=()=>{setT(Number((parent as unknown as {__T?:number}).__T??0));r=requestAnimationFrame(loop);};r=requestAnimationFrame(loop);return()=>cancelAnimationFrame(r);},[]);
 return <div className="map-only-root"><MapView t={t}/></div>;
}
createRoot(document.getElementById('root')!).render(new URLSearchParams(location.search).has('map')?<MapOnly/>:<Video/>);
