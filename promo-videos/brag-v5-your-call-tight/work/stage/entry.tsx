// "Your own little swarm" — tight cut (v5): continuous motion, overlapping transitions, readable Kill confirm, repo URL.
// Based on brag-v3-your-call. Every frame is a function of window.__T (the capture script sets it and fakes the clock).
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
/** Gentle idle bob so nothing on screen is ever fully still. */
const bob=(t:number,i=0,amp=7)=>Math.sin(t*2.2+i*1.7)*amp;
/** Slow camera push-in across a scene. */
const push=(t:number,a:number,b:number,amt=.06)=>`scale(${1+amt*p(t,a,b)})`;
const HOLD=19.2; // final poster hold starts here
/** Soft fade/rise in at a, fade out ending at b. */
function show(t:number,a:number,b:number,dy=18,dur=.45,outDur=.3):CSSProperties{const i=out3(p(t,a,a+dur)),o=p(t,b-outDur,b);return {opacity:i*(1-o),transform:`translateY(${(1-i)*dy}px)`};}

const TONES:Record<string,string>={fox:'--pastel-butter',cat:'--pastel-sky',frog:'--pastel-mint',dog:'--pastel-blush',owl:'--pastel-lilac',tiger:'--pastel-butter',koala:'--pastel-sky',raccoon:'--pastel-mint',bear:'--pastel-blush',panda:'--pastel-lilac',rabbit:'--pastel-blush','red-panda':'--pastel-butter'};
function Tile({character,size,state='idle',style}:{character:string;size:number;state?:CommunicationAgentState;style?:CSSProperties}){
 return <div className="tile" style={{width:size,height:size,background:`var(${TONES[character]??'--pastel-lilac'})`,...style}}>
  <div className="tile-face" data-character-motion-root=""><CharacterAvatar character={character} src={characterSource(character)} state={state} animationKey={character}/></div>
 </div>;
}
function Scene({t,a,b,caption,children}:{t:number;a:number;b:number;caption?:ReactNode;children?:ReactNode}){
 // Incoming scene starts 0.3 s before its bar line and overlaps the outgoing one, which fades over its last 0.25 s.
 if(!on(t,a-.02,b+.02))return null;
 return <div className="scene" style={{opacity:1-p(t,b-.2,b),transform:`${push(t,a-.02,b,.05)} translateY(${-p(t,b-.2,b)*24}px)`,transformOrigin:'50% 45%'}}>
  {caption&&<h2 className="caption" style={show(t,a,b+1,18,.32)}>{caption}</h2>}
  <div className="content">{children}</div>
 </div>;
}

// ---------- cursor ----------
type Key={t:number;sel:string;fx?:number;fy?:number};
const seen=new Map<string,{x:number;y:number}>();
function at(sel:string,fx=.5,fy=.55){const key=`${sel}|${fx}|${fy}`;const el=document.querySelector(sel);if(!el)return seen.get(key)??null;const r=el.getBoundingClientRect();const v={x:r.left+r.width*fx,y:r.top+r.height*fy};seen.set(key,v);return v;}
function Cursor({t,keys,clicks,from,until}:{t:number;keys:Key[];clicks:number[];from:number;until:number}){
 if(!on(t,from,until))return null;
 const raw=keys.map(k=>at(k.sel,k.fx,k.fy));if(raw.some(r=>!r))return null;
 const pts=keys.map((k,i)=>({t:k.t,...raw[i]!}));
 let x=pts[0].x,y=pts[0].y;
 for(let i=1;i<pts.length;i++){const m=inOut(p(t,pts[i].t-.45,pts[i].t));x+= (pts[i].x-pts[i-1].x)*m;y+=(pts[i].y-pts[i-1].y)*m;}
 const down=clicks.some(c=>t>=c-.08&&t<c+.04);
 const fade=p(t,from,from+.2)*(1-p(t,until-.2,until));
 return <svg className="cursor" style={{left:x,top:y,opacity:fade,transform:`scale(${down?.86:1})`}} width="46" height="55" viewBox="0 0 17 20"><path d="M1 1 L1 16 L5 12.5 L8 19 L10.5 18 L7.6 11.6 L13 11.6 Z" fill="#141414" stroke="#fff" strokeWidth="1.3" strokeLinejoin="round"/></svg>;
}

// ---------- 1–3: hook, few, reveal ----------
const TRIO=['fox','cat','frog'] as const;
const CROWD_CH=['cat','dog','raccoon','bear','panda','rabbit','owl','koala','red-panda','tiger','frog','fox'];
// "A hundred agents": a crowd grid that is on screen from frame 0 and thins out to one fox.
const CROWD=(()=>{const cols=SQ?9:14,rows=SQ?6:6,s=SQ?92:96,gx=SQ?116:128,gy=SQ?112:126;const W=SQ?1080:1920,H=1080;const out:{x:number;y:number;c:string;d:number;s:number}[]=[];
 for(let r=0;r<rows;r++)for(let c=0;c<cols;c++){const x=W/2+(c-(cols-1)/2)*gx,y=(SQ?700:690)+(r-(rows-1)/2)*gy;const d=Math.hypot(x-W/2,y-(SQ?600:620));if(d<160)continue;out.push({x,y,c:CROWD_CH[(r*5+c*7)%CROWD_CH.length],d,s});}
 const maxD=Math.max(...out.map(o=>o.d));out.forEach(o=>o.d/=maxD);return out;})();
function Crowd({t}:{t:number}){
 if(t>2.3)return null;
 return <>{CROWD.map((o,i)=>{
  const inn=out3(p(t,o.d*.35,o.d*.35+.35));          // ripples in from the centre, 0–0.7 s
  const leave=inOut(p(t,1.0+(1-o.d)*.0+o.d*.6,1.35+o.d*.6)); // outer ring leaves last
  const k=inn*(1-leave);
  return <Tile key={i} character={o.c} size={o.s} style={{left:o.x+bob(t,i,3),top:o.y+(1-inn)*16,opacity:k*.9,transform:`translate(-50%,-50%) scale(${.7+.3*k})`}}/>;
 })}</>;
}
function Opening({t}:{t:number}){
 const shrink=inOut(p(t,5.0,5.5)),gone=p(t,7.08,7.34);
 const size=(SQ?190:210)*(1-shrink*.45),gap=(SQ?40:56)*(1-shrink*.3);
 const y=(SQ?600:620)+shrink*(SQ?240:250);
 return <div className="layer" style={{opacity:1-gone,transform:`${push(t,0,7.5,.05)} translateY(${-gone*30}px)`,transformOrigin:'50% 50%'}}>
  <Crowd t={t}/>
  <h2 className="caption hook" style={show(t,0,2.45,18,.3)}>You don’t need a hundred agents.</h2>
  <h2 className="caption hook" style={show(t,2.5,4.95)}>Just a few. And you’re in charge.</h2>
  <div className="reveal" style={{...show(t,5.05,7.5,24,.5)}}><span className="wordmark-logo big" style={{transform:`scale(${1+.04*p(t,5.05,7.5)})`}}>Minions</span></div>
  <p className="tagline" style={show(t,5.3,7.5,16,.45)}>Your own little swarm of coding agents.</p>
  {TRIO.map((c,i)=>{
   const appear=i===0?1:back(p(t,2.5+(i-1)*E,2.5+(i-1)*E+.35));
   const spread=i===0?inOut(p(t,2.35,2.75)):1;
   const x=SQ?540:960,off=(i-1)*(size+gap)*spread;
   const grow=i===0?.82+.18*out3(p(t,0,2.0)):appear; // the fox grows as the crowd leaves
   return <Tile key={c} character={c} size={size} state={t<2.5?'idle':'working'} style={{left:x+(i===0?-(size+gap)*spread:off),top:y+bob(t,i,(1-shrink*.5)*8),opacity:i===0?1:(appear>0?Math.min(1,appear*2):0),transform:`translate(-50%,-50%) scale(${grow})`,zIndex:3}}/>;
  })}
 </div>;
}

// ---------- 4: you set the job ----------
function Setup({t}:{t:number}){
 const started=t>=9.0625;
 const n=t<7.75?1:t<8.0625?2:3; // stepper counts up on eighth notes
 const dur=t<8.4?'30 min':'1 hour';
 const boot=p(t,9.15,9.95);
 return <Scene t={t} a={7.32} b={10.0} caption="Nothing starts without your yes.">
  <div className="card setup" style={show(t,7.3,99,24,.35)}>
   <h3>Start the job</h3>
   <div className="row"><span className="label">Agents</span><span className="stepper"><button><Minus size={16}/></button><b key={n} style={{display:'inline-block',transform:`scale(${1+.25*(1-p(t,n===2?7.75:n===3?8.0625:0,(n===2?7.75:n===3?8.0625:0)+.25))})`}}>{n}</b><button className={n<3?'hot':''}><Plus size={16}/></button></span>
    <span className="mini">{TRIO.slice(0,n).map((c,i)=>{const at=i===0?7.42:i===1?7.75:8.0625;const k=back(p(t,at,at+.3));return <Tile key={c} character={c} size={44} state={started?'working':'idle'} style={{position:'relative',transform:`scale(${k}) translateY(${started?bob(t,i,2):0}px)`}}/>;})}</span></div>
   <div className="row"><span className="label">How long?</span><span className="select" style={{boxShadow:t>8.2&&t<8.7?'0 0 0 3px rgba(0,102,255,.25)':undefined}}>{dur} <ChevronDown size={18}/></span></div>
   <div className="row"><span className="label">Runs on</span><span className="value">This computer · your Claude Code sign-in</span></div>
   <div className="actions">{started&&<span className="booting" style={{opacity:out3(p(t,9.15,9.4))}}>Starting {Math.min(3,1+Math.floor(boot*3))} of 3…</span>}<button className="ghost">Not now</button><button className={`primary go${started?' done':''}`} id="start">{started?<><Check size={18}/> Started</>:'Start'}</button></div>
  </div>
 </Scene>;
}

// ---------- 5 & 7: the board ----------
const ROWS=[
 {c:'fox',name:'claude-builder',focus:['Building the player controller','Tuning jump height','Running the level-one playtest']},
 {c:'cat',name:'claude-art',focus:['Drawing the sprite sheet','Animating the run cycle','Exporting tiles for level two']},
 {c:'frog',name:'codex-tests',focus:['Writing collision tests','12 of 14 tests passing','Checking the save-file loader']},
] as const;
const PAUSE_AT=15.3125,MORE_AT=15.9375,KILL_AT=16.25; // eighth-note clicks
function Board({t,phase}:{t:number;phase:'see'|'control'}){
 const paused=phase==='control'&&t>=PAUSE_AT, more=phase==='control'&&t>=MORE_AT, confirm=phase==='control'&&t>=KILL_AT;
 const tokens=Math.round(phase==='see'?96+28*p(t,9.7,12.5):124+9*p(t,14.7,17.5));
 const secs=phase==='see'?Math.round(52*60-(t-9.7)*37):Math.round((more?79:49)*60-(t-14.7)*37); // a little fast-forwarded
 const clock=`${Math.floor(secs/60)}:${String(secs%60).padStart(2,'0')}`;
 const bump=phase==='control'?1-p(t,MORE_AT,MORE_AT+.4):0;
 return <div className="board">
  <section className="k42-job-bar">
   <div className="k42-job-parts">
    <div className="k42-job-part"><span className="k42-job-label">Time</span><span className="k42-job-value" style={{color:bump>0&&more?`rgba(31,157,85,${.4+.6*bump})`:undefined}}>Ends {more?'15:30':'15:00'} · {clock} left</span><button className="soft" id="add-time"><Plus size={14}/>30 min</button></div>
    <div className="k42-job-part"><span className="k42-job-label">Tokens</span><span className="k42-job-value tnum">{tokens}K of 500K</span><span className="k42-job-meter"><span style={{width:`${tokens/5}%`}}/></span><button className="soft">Change cap</button></div>
   </div>
  </section>
  {ROWS.map((r,i)=>{
   const isPaused=paused&&i===0, killing=confirm&&i===1;
   const state:CommunicationAgentState=isPaused?'paused':'working';
   // each agent's focus line updates during the scene, staggered
   const base=phase==='see'?10.6:14.4, step=phase==='see'?0:1;
   const fi=Math.min(2,step+(t>=base+i*.55?1:0)); const changedAt=base+i*.55;
   const flash=1-p(t,changedAt,changedAt+.5);
   const dotPulse=.55+.45*Math.abs(Math.sin(t*3+i));
   return <div className={`agent-row${killing?' killing':''}`} key={r.c} style={show(t,(phase==='see'?10.02:15.02)+i*.09,99,14,.4)}>
    <Tile character={r.c} size={SQ?84:92} state={state} style={{position:'relative',transform:`translateY(${isPaused?0:bob(t,i,2.5)}px)`}}/>
    <div className="who"><strong>{r.name}</strong><span className={`status${isPaused?' paused':''}`}><i style={{opacity:isPaused?1:dotPulse}}/>{isPaused?'Paused · finishes its turn first':<>Working · <span style={{background:t>=changedAt&&flash>0?`rgba(31,157,85,${.18*flash})`:undefined,borderRadius:4,padding:'0 3px'}}>{r.focus[fi]}</span></>}</span></div>
    <div className="ctl">
     {killing?<span className="confirm" style={{opacity:out3(p(t,KILL_AT,KILL_AT+.2))}}>Kill this agent? It cannot be undone.<button className="soft">Keep</button><button className="danger">Kill</button></span>:<>
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
   <Tile character="frog" size={SQ?150:200} state={sent?'working':'needs_you'} style={{position:'relative',...show(t,12.52,99,14,.35),translate:`0 ${bob(t,0,9)}px`,rotate:`${sent?0:Math.sin(t*5)*2.5}deg`}}/>
   <div className="needs-card" style={{...show(t,12.55,99,20,.35),boxShadow:sent?undefined:`0 0 0 ${4+4*Math.abs(Math.sin(t*2.6))}px rgba(234,179,8,.22)`,borderRadius:18}}>
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
 const tt=Math.min(t,HOLD);
 return <div className="layer" style={{transform:`scale(${1.04-.04*out3(p(t,17.4,HOLD))})`,transformOrigin:'50% 45%'}}>
  <div className="reveal outro" style={show(t,17.45,99,24,.4)}><span className="wordmark-logo big">Minions</span></div>
  <p className="tagline outro" style={show(t,17.6,99,16,.4)}>Your agents. Your computer. Your call.</p>
  <div className="outro-row" style={show(t,17.85,99,14,.4)}><span className="pill"><code>npm run setup</code></span><span className="url">github.com/latent-spaces/minions</span></div>
  {TRIO.map((c,i)=>{const k=back(p(t,17.5+i*E,17.5+i*E+.35));const s=SQ?110:120,g=36;const damp=1-p(t,HOLD-.6,HOLD);return <Tile key={c} character={c} size={s} state="working" style={{left:(SQ?540:960)+(i-1)*(s+g),top:(SQ?900:880)+bob(tt,i,9)*damp,opacity:k>0?1:0,transform:`translate(-50%,-50%) scale(${k})`}}/>;})}
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
  <Scene t={t} a={15.0} b={17.42} caption="Pause it. Kill it. Give it more time."><Board t={t} phase="control"/></Scene>
  {t>=17.44&&<Outro t={t}/>}
  <Cursor t={t} from={7.5} until={9.75} keys={[{t:7.5,sel:'.stepper button:last-child',fx:1.6,fy:1.6},{t:7.7,sel:'.stepper button:last-child'},{t:8.35,sel:'.setup .select',fx:.7},{t:9.0,sel:'#start'}]} clicks={[7.75,8.0625,8.375,9.0625]}/>
  <Cursor t={t} from={12.8} until={14.8} keys={[{t:12.8,sel:'.needs-card',fx:.95,fy:1.1},{t:13.7,sel:'#choice-a',fx:.4},{t:14.3,sel:'#send'}]} clicks={[13.75,14.375]}/>
  <Cursor t={t} from={14.95} until={17.35} keys={[{t:14.95,sel:'.board',fx:.7,fy:1.08},{t:15.29,sel:'#pause-0'},{t:15.92,sel:'#add-time'},{t:16.23,sel:'#kill-1'},{t:17.1,sel:'.killing .confirm',fx:.5,fy:2.2}]} clicks={[PAUSE_AT,MORE_AT,KILL_AT]}/>
 </div>;
}
createRoot(document.getElementById('root')!).render(<Video/>);
