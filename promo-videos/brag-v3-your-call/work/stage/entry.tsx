// "Your own little swarm" — the control cut. Every frame is a function of window.__T (the capture script sets it and fakes the clock).
// Real Minions CSS, character assets and wording; all data is synthetic.
import {createRoot} from 'react-dom/client';
import {useEffect,useState,type CSSProperties,type ReactNode} from 'react';
import type {CommunicationAgentState} from '@minions/contracts';
import {CharacterAvatar} from '../../../../apps/web/src/ui/CharacterAvatar';
import {characterSource} from '../../../../apps/web/src/ui/character-set';
import {Check,PenLine,Pause,Play,Plus,ChevronDown,Minus} from 'lucide-react';
import '../../../../apps/web/src/styles.css';
import '../../../../apps/web/src/ui/theme.css';
import '../../../../apps/web/src/ui/application-shell.css';
import '../../../../apps/web/src/ui/needs-you.css';
import '../../../../apps/web/src/ui/job-limits.css';
import './stage.css';

const SQ=new URLSearchParams(location.search).get('fmt')==='square';
const E=0.3125; // eighth note at 96 BPM; bar = 2.5s
const clamp=(v:number,a=0,b=1)=>Math.min(b,Math.max(a,v));
const p=(t:number,a:number,b:number)=>clamp((t-a)/(b-a));
const out3=(x:number)=>1-Math.pow(1-x,3);
const back=(x:number)=>{const c=1.4;return 1+(c+1)*Math.pow(x-1,3)+c*Math.pow(x-1,2);};
const inOut=(x:number)=>x<.5?4*x*x*x:1-Math.pow(-2*x+2,3)/2;
const on=(t:number,a:number,b:number)=>t>=a&&t<b;
/** Soft fade/rise in at a, fade out ending at b. */
function show(t:number,a:number,b:number,dy=18,dur=.45,outDur=.3):CSSProperties{const i=out3(p(t,a,a+dur)),o=p(t,b-outDur,b);return {opacity:i*(1-o),transform:`translateY(${(1-i)*dy}px)`};}

const TONES:Record<string,string>={fox:'--pastel-butter',cat:'--pastel-sky',frog:'--pastel-mint',dog:'--pastel-blush'};
function Tile({character,size,state='idle',style}:{character:string;size:number;state?:CommunicationAgentState;style?:CSSProperties}){
 return <div className="tile" style={{width:size,height:size,background:`var(${TONES[character]??'--pastel-lilac'})`,...style}}>
  <div className="tile-face" data-character-motion-root=""><CharacterAvatar character={character} src={characterSource(character)} state={state} animationKey={character}/></div>
 </div>;
}
function Scene({t,a,b,caption,children}:{t:number;a:number;b:number;caption?:ReactNode;children?:ReactNode}){
 if(!on(t,a-.05,b+.05))return null;
 return <div className="scene" style={{opacity:1-p(t,b-.3,b)}}>
  {caption&&<h2 className="caption" style={show(t,a+.1,b+1,18)}>{caption}</h2>}
  <div className="content">{children}</div>
 </div>;
}

// ---------- cursor ----------
type Key={t:number;sel:string;fx?:number;fy?:number};
const seen=new Map<string,{x:number;y:number}>();
function at(sel:string,fx=.5,fy=.55){const key=`${sel}|${fx}|${fy}`;const el=document.querySelector(sel);if(!el)return seen.get(key)??null;const r=el.getBoundingClientRect();const v={x:r.left+r.width*fx,y:r.top+r.height*fy};seen.set(key,v);return v;}
function Cursor({t,keys,clicks,from,until}:{t:number;keys:Key[];clicks:number[];from:number;until:number}){
 if(!on(t,from,until))return null;
 const pts=keys.map(k=>({t:k.t,...(at(k.sel,k.fx,k.fy)??{x:0,y:0})}));
 let x=pts[0].x,y=pts[0].y;
 for(let i=1;i<pts.length;i++){const m=inOut(p(t,pts[i].t-.45,pts[i].t));x+= (pts[i].x-pts[i-1].x)*m;y+=(pts[i].y-pts[i-1].y)*m;}
 const down=clicks.some(c=>t>=c-.08&&t<c+.04);
 const fade=p(t,from,from+.2)*(1-p(t,until-.2,until));
 return <svg className="cursor" style={{left:x,top:y,opacity:fade,transform:`scale(${down?.86:1})`}} width="46" height="55" viewBox="0 0 17 20"><path d="M1 1 L1 16 L5 12.5 L8 19 L10.5 18 L7.6 11.6 L13 11.6 Z" fill="#141414" stroke="#fff" strokeWidth="1.3" strokeLinejoin="round"/></svg>;
}

// ---------- 1–3: hook, few, reveal ----------
const TRIO=['fox','cat','frog'] as const;
function Opening({t}:{t:number}){
 const shrink=inOut(p(t,5.0,5.5)),gone=p(t,7.2,7.5);
 const size=(SQ?190:210)*(1-shrink*.45),gap=(SQ?40:56)*(1-shrink*.3);
 const y=(SQ?600:620)+shrink*(SQ?240:250);
 return <div className="layer" style={{opacity:1-gone}}>
  <h2 className="caption hook" style={show(t,0,2.45,18,.35)}>You don’t need a hundred agents.</h2>
  <h2 className="caption hook" style={show(t,2.55,4.95)}>Just a few. And you’re in charge.</h2>
  <div className="reveal" style={show(t,5.05,7.5,24,.5)}><span className="wordmark-logo big">Minions</span></div>
  <p className="tagline" style={show(t,5.3,7.5,16,.45)}>Your own little swarm of coding agents.</p>
  {TRIO.map((c,i)=>{
   const appear=i===0?out3(p(t,0,.5)):back(p(t,2.5+(i-1)*E,2.5+(i-1)*E+.35));
   const spread=i===0?inOut(p(t,2.35,2.75)):1;
   const x=SQ?540:960,off=(i-1)*(size+gap)*spread;
   return <Tile key={c} character={c} size={size} state={t<2.5?'idle':'working'} style={{left:x+(i===0?-(size+gap)*spread:off),top:y,opacity:appear>0?Math.min(1,appear*2):0,transform:`translate(-50%,-50%) scale(${i===0?.9+.1*appear:appear})`}}/>;
  })}
 </div>;
}

// ---------- 4: you set the job ----------
function Setup({t}:{t:number}){
 const started=t>=9.0625;
 return <Scene t={t} a={7.5} b={10.0} caption="Nothing starts without your yes.">
  <div className="card setup" style={show(t,7.55,99,24,.5)}>
   <h3>Start the job</h3>
   <div className="row"><span className="label">Agents</span><span className="stepper"><button><Minus size={16}/></button><b>3</b><button><Plus size={16}/></button></span>
    <span className="mini">{TRIO.map(c=><Tile key={c} character={c} size={44} style={{position:'relative'}}/>)}</span></div>
   <div className="row"><span className="label">How long?</span><span className="select">1 hour <ChevronDown size={18}/></span></div>
   <div className="row"><span className="label">Runs on</span><span className="value">This computer · your Claude Code sign-in</span></div>
   <div className="actions"><button className="ghost">Not now</button><button className={`primary go${started?' done':''}`} id="start">{started?<><Check size={18}/> Started</>:'Start'}</button></div>
  </div>
 </Scene>;
}

// ---------- 5 & 7: the board ----------
const ROWS=[{c:'fox',name:'claude-builder',focus:'Building the player controller'},{c:'cat',name:'claude-art',focus:'Drawing the sprite sheet'},{c:'frog',name:'codex-tests',focus:'Writing collision tests'}] as const;
function Board({t,phase}:{t:number;phase:'see'|'control'}){
 const paused=phase==='control'&&t>=15.625, more=phase==='control'&&t>=16.25, confirm=phase==='control'&&t>=16.875;
 const tokens=Math.round(phase==='see'?96+24*p(t,10,12.5):121+3*p(t,15,17.5));
 const left=phase==='see'?52-Math.floor(p(t,10,12.5)*2):(more?79:49);
 return <div className="board">
  <section className="k42-job-bar">
   <div className="k42-job-parts">
    <div className="k42-job-part"><span className="k42-job-label">Time</span><span className="k42-job-value">Ends {more?'15:30':'15:00'} · {left} min left</span><button className="soft" id="add-time"><Plus size={14}/>30 min</button></div>
    <div className="k42-job-part"><span className="k42-job-label">Tokens</span><span className="k42-job-value">{tokens}K of 500K</span><span className="k42-job-meter"><span style={{width:`${tokens/5}%`}}/></span><button className="soft">Change cap</button></div>
   </div>
  </section>
  {ROWS.map((r,i)=>{
   const isPaused=paused&&i===0;
   const state:CommunicationAgentState=isPaused?'paused':'working';
   return <div className="agent-row" key={r.c} style={show(t,(phase==='see'?10.05:15.0)+i*.12,99,14,.4)}>
    <Tile character={r.c} size={SQ?84:92} state={state} style={{position:'relative'}}/>
    <div className="who"><strong>{r.name}</strong><span className={`status${isPaused?' paused':''}`}><i/>{isPaused?'Paused · finishes its turn first':`Working · ${r.focus}`}</span></div>
    <div className="ctl">
     {i===1&&confirm?<span className="confirm">Kill this agent? It cannot be undone.<button className="soft">Keep</button><button className="danger">Kill</button></span>:<>
      <button className="soft icon" id={`pause-${i}`}>{isPaused?<Play size={18}/>:<Pause size={18}/>}</button>
      <button className="soft" id={`kill-${i}`}>Kill</button></>}
    </div>
   </div>;})}
 </div>;
}

// ---------- 6: needs you ----------
function Needs({t}:{t:number}){
 const picked=t>=13.75,sent=t>=14.375;
 return <Scene t={t} a={12.5} b={15.0} caption="They ask you when they’re stuck.">
  <div className="needs-layout">
   <Tile character="frog" size={SQ?150:200} state={sent?'working':'needs_you'} style={{position:'relative',...show(t,12.55,99,14,.4)}}/>
   <div className="needs-card" style={show(t,12.7,99,20,.45)}>
    <article className="k42-needs-item" data-waiting={sent?undefined:'true'}>
     <header className="k42-needs-who"><span><strong>codex-tests</strong><span className="k42-needs-arrow"> → </span><strong>You</strong></span><span className="k42-needs-meta"><span>2D game</span><time>now</time></span></header>
     <h3 className="k42-needs-question">Can I remove the old save-file format?</h3>
     <p className="k42-needs-detail">Two levels still load it. I’d migrate them first.</p>
     {!sent?<><fieldset className="k42-needs-choices">
      <label className="k42-needs-choice" id="choice-a"><input type="radio" readOnly checked={picked}/><span className="k42-needs-letter">A</span><span className="k42-needs-choice-text">Yes, migrate the two levels first</span><Check size={16} className="k42-needs-tick"/></label>
      <label className="k42-needs-choice"><input type="radio" readOnly checked={false}/><span className="k42-needs-letter">B</span><span className="k42-needs-choice-text">No, keep it for now</span><Check size={16} className="k42-needs-tick"/></label>
      <label className="k42-needs-choice is-own"><input type="radio" readOnly checked={false}/><span className="k42-needs-letter"><PenLine size={13}/></span><span className="k42-needs-choice-text muted">Write your own answer</span></label>
     </fieldset><div className="k42-needs-send"><button className="primary" id="send" disabled={!picked}>Send answer</button></div></>
     :<div className="k42-needs-answer" style={show(t,14.375,99,8,.25)}><p><strong>You answered: </strong>Yes, migrate the two levels first</p><p className="muted">codex-tests is back to work</p></div>}
    </article>
   </div>
  </div>
 </Scene>;
}

// ---------- 8: outro ----------
function Outro({t}:{t:number}){
 return <div className="layer">
  <div className="reveal outro" style={show(t,17.5,99,24,.5)}><span className="wordmark-logo big">Minions</span></div>
  <p className="tagline outro" style={show(t,17.8,99,16,.45)}>Your agents. Your computer. Your call.</p>
  <div className="outro-row" style={show(t,18.1,99,14,.4)}><span className="pill"><code>npm run setup</code></span></div>
  {TRIO.map((c,i)=>{const k=back(p(t,17.5+i*E,17.5+i*E+.35));const s=SQ?110:120,g=36;return <Tile key={c} character={c} size={s} state="working" style={{left:(SQ?540:960)+(i-1)*(s+g),top:SQ?900:880,opacity:k>0?1:0,transform:`translate(-50%,-50%) scale(${k})`}}/>;})}
 </div>;
}

function useT(read:()=>number){const [t,setT]=useState(0);useEffect(()=>{let r=0;const loop=()=>{setT(read());r=requestAnimationFrame(loop);};r=requestAnimationFrame(loop);return()=>cancelAnimationFrame(r);},[]);return t;}
function Video(){
 const t=useT(()=>Number((window as unknown as {__T?:number}).__T??0));
 (window as unknown as {__t:number}).__t=t;
 return <div className={`stage${SQ?' sq':''}`}>
  {t<7.55&&<Opening t={t}/>}
  <Setup t={t}/>
  <Scene t={t} a={10.0} b={12.5} caption="See what each one is doing."><Board t={t} phase="see"/></Scene>
  <Needs t={t}/>
  <Scene t={t} a={15.0} b={17.5} caption="Pause it. Kill it. Give it more time."><Board t={t} phase="control"/></Scene>
  {t>=17.45&&<Outro t={t}/>}
  <Cursor t={t} from={8.2} until={9.6} keys={[{t:8.2,sel:'.setup .row:nth-of-type(2)',fx:.9,fy:1.4},{t:9.0,sel:'#start'}]} clicks={[9.0625]}/>
  <Cursor t={t} from={13.1} until={14.7} keys={[{t:13.1,sel:'.needs-card',fx:.85,fy:1.05},{t:13.7,sel:'#choice-a',fx:.4},{t:14.3,sel:'#send'}]} clicks={[13.75,14.375]}/>
  <Cursor t={t} from={15.15} until={17.45} keys={[{t:15.15,sel:'.board',fx:.7,fy:1.08},{t:15.6,sel:'#pause-0'},{t:16.2,sel:'#add-time'},{t:16.85,sel:'#kill-1'}]} clicks={[15.625,16.25,16.875]}/>
 </div>;
}
createRoot(document.getElementById('root')!).render(<Video/>);
