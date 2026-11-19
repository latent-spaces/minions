// "Minions: A Natural History" — every frame is a function of window.__T (capture.mjs sets it and fakes the clock).
// Real Minions CSS, characters and communication map; all data is synthetic.
import {createRoot} from 'react-dom/client';
import {useEffect,useState,type CSSProperties,type ReactNode} from 'react';
import type {CommunicationAgent,CommunicationAgentState} from '@minions/contracts';
import {CharacterAvatar} from '../../../../apps/web/src/ui/CharacterAvatar';
import {characterSource} from '../../../../apps/web/src/ui/character-set';
import {CommunicationMap} from '../../../../apps/web/src/ui/communication-map/CommunicationMap';
import type {MapNode} from '../../../../apps/web/src/ui/communication-map/protocol';
import type {Traffic} from '../../../../apps/web/src/ui/communication-map/layout';
import {ProjectUpdates} from '../../../../apps/web/src/ui/ProjectProgress';
import type {ProgressPage,ProgressScreenshot,PublishedUpdate} from '@minions/contracts';
import '../../../../apps/web/src/ui/project-progress.css';
// Lazy images must already be loaded when the camera reaches them: treat everything as in view.
(window as any).IntersectionObserver=class{constructor(private cb:IntersectionObserverCallback){}observe(el:Element){queueMicrotask(()=>this.cb([{isIntersecting:true,target:el} as any],this as any));}unobserve(){}disconnect(){}takeRecords(){return [];}};
import {Check,PenLine,ChevronDown,Plus} from '../../../../apps/web/src/ui/icons';
import '../../../../apps/web/src/styles.css';
import '../../../../apps/web/src/ui/theme.css';
import '../../../../apps/web/src/ui/application-shell.css';
import '../../../../apps/web/src/ui/needs-you.css';
import '../../../../apps/web/src/ui/job-limits.css';
import '../../../../apps/web/src/ui/project-communication.css';
import './stage.css';
import SOC from './social.json';
const SOCIAL=new URLSearchParams(location.search).get('fmt')==='square';
/** Stage pixels per screen pixel: 1 in the film, the camera scale in the social cut. */
const stageScale=()=>{const st=document.querySelector('.stage');return st?st.getBoundingClientRect().width/1920:1;};

const clamp=(v:number,a=0,b=1)=>Math.min(b,Math.max(a,v));
const p=(t:number,a:number,b:number)=>clamp((t-a)/(b-a));
const out3=(x:number)=>1-Math.pow(1-x,3);
const back=(x:number)=>{const c=1.5;return x<=0?0:1+(c+1)*Math.pow(x-1,3)+c*Math.pow(x-1,2);};
const inOut=(x:number)=>x<.5?4*x*x*x:1-Math.pow(-2*x+2,3)/2;
const on=(t:number,a:number,b:number)=>t>=a&&t<b;
const lerp=(a:number,b:number,k:number)=>a+(b-a)*k;
function show(t:number,a:number,b=999,dy=18,dur=.45,outDur=.3):CSSProperties{const i=out3(p(t,a,a+dur)),o=p(t,b-outDur,b);return {opacity:i*(1-o),transform:`translateY(${(1-i)*dy}px)`};}

// ---------- timing (seconds) — narration starts; durations from vo/durations.json ----------
export const VO:[string,number,string][]=[
 ['open1',2.6,"Here, in the warm glow of a developer’s laptop, lives one of nature’s most remarkable creatures."],
 ['open2',10.9,'The minion.'],
 ['rel1',15.2,'It is Friday afternoon. The human has a great many tokens left… and six terminals it has quite forgotten about.'],
 ['rel2',24.9,'So it does the only sensible thing. It writes one task… and releases the minions.'],
 ['com1',34.2,'Watch closely. No manager. No stand-up meeting. They simply… talk.'],
 ['com2',40.5,'A message here. A reply there. Each one knows precisely what the others are up to.'],
 ['div1',49.4,'Here, a young fox claims the login bug. The cat, wisely, backs away… and takes the flaky test instead.'],
 ['div2',58.5,'Within minutes, teams have formed. Nobody asked for a hierarchy. Nobody ever does.'],
 ['feed1',67.8,'And, like all proud creatures, they display their work.'],
 ['feed2',72.7,'The human observes from a safe distance. Scrolling. Occasionally nodding.'],
 ['help1',81.2,'But when a minion is truly stuck… it raises its hand, and asks.'],
 ['help2',87.2,'A behaviour almost never seen in the wild.'],
 ['rest1',93.8,'As the hour ends, the swarm settles. Every token accounted for. Nothing ran that the human did not allow.'],
 ['end1',103.4,'Truly… magnificent.'],
 ['end2',107.2,'And now… a nice cup of tea.'],
];
const DUR:Record<string,number>={open1:7.75,open2:1.65,rel1:9.1,rel2:6.9,com1:5.75,com2:6.53,div1:8.5,div2:6.88,feed1:4.35,feed2:6.15,help1:5.38,help2:4.28,rest1:8.47,end1:2.58,end2:2.98};
export const END=113;
const CHAPTERS=[
 {n:'I',title:'The Release',a:13.4},
 {n:'II',title:'Communication',a:32.4},
 {n:'III',title:'Dividing the Work',a:47.6},
 {n:'IV',title:'The Display',a:66.0},
 {n:'V',title:'The Call for Help',a:79.4},
 {n:'VI',title:'Rest',a:92.0},
];
const CARD=1.6;

// ---------- shared pieces ----------
const TONES:Record<string,string>={fox:'--pastel-butter',cat:'--pastel-sky',frog:'--pastel-mint',dog:'--pastel-blush',owl:'--pastel-lilac',raccoon:'--pastel-blush',panda:'--pastel-mint',bear:'--pastel-butter',rabbit:'--pastel-sky',koala:'--pastel-lilac','red-panda':'--pastel-butter',tiger:'--pastel-blush'};
function Tile({character,size,state='idle',style,id}:{character:string;size:number;state?:CommunicationAgentState;style?:CSSProperties;id?:string}){
 return <div className="tile" id={id} style={{width:size,height:size,background:`var(${TONES[character]??'--pastel-lilac'})`,...style}}>
  <div className="tile-face" data-character-motion-root=""><CharacterAvatar character={character} src={characterSource(character)} state={state} animationKey={character}/></div>
 </div>;
}
function Specimen({t,a,b,latin,common,right}:{t:number;a:number;b:number;latin:string;common:string;right?:boolean}){
 if(!on(t,a,b))return null;
 const k=out3(p(t,a,a+.5)),o=p(t,b-.4,b);
 return <div className={`specimen${right?' right':''}`} style={{opacity:k*(1-o),transform:`translateX(${(1-k)*(right?30:-30)}px)`}}><i>{latin}</i><span>{common}</span></div>;
}
type Key={t:number;sel:string;fx?:number;fy?:number};
const seen=new Map<string,{x:number;y:number}>();
function at(sel:string,fx=.5,fy=.55){const key=`${sel}|${fx}|${fy}`;const el=document.querySelector(sel);if(!el)return seen.get(key)??null;const r=el.getBoundingClientRect(),st=document.querySelector('.stage')!.getBoundingClientRect(),k=st.width/1920;const v={x:(r.left+r.width*fx-st.left)/k,y:(r.top+r.height*fy-st.top)/k};seen.set(key,v);return v;}
function Cursor({t,keys,clicks,from,until}:{t:number;keys:Key[];clicks:number[];from:number;until:number}){
 if(!on(t,from,until))return null;
 const pts=keys.map(k=>({t:k.t,...(at(k.sel,k.fx,k.fy)??{x:960,y:540})}));
 let x=pts[0].x,y=pts[0].y;
 for(let i=1;i<pts.length;i++){const m=inOut(p(t,pts[i].t-.45,pts[i].t));x+=(pts[i].x-pts[i-1].x)*m;y+=(pts[i].y-pts[i-1].y)*m;}
 const down=clicks.some(c=>t>=c-.08&&t<c+.04);
 const fade=p(t,from,from+.2)*(1-p(t,until-.2,until));
 return <svg className="cursor" style={{left:x,top:y,opacity:fade,transform:`scale(${down?.86:1})`}} width="46" height="55" viewBox="0 0 17 20"><path d="M1 1 L1 16 L5 12.5 L8 19 L10.5 18 L7.6 11.6 L13 11.6 Z" fill="#141414" stroke="#fff" strokeWidth="1.3" strokeLinejoin="round"/></svg>;
}
/** Word-ish progress inside a narration line: 0 at its start, 1 at its end. */
const vo=(t:number,k:string)=>{const row=VO.find(r=>r[0]===k)!;return p(t,row[1],row[1]+DUR[k]);};
const voAt=(k:string,frac:number)=>{const row=VO.find(r=>r[0]===k)!;return row[1]+DUR[k]*frac;};

// ---------- 0: the habitat ----------
const HABITAT:{c:string;x:number;y:number;s:number;st:CommunicationAgentState}[]=[
 {c:'owl',x:330,y:330,s:150,st:'idle'},{c:'raccoon',x:640,y:250,s:130,st:'working'},{c:'cat',x:1290,y:260,s:140,st:'idle'},{c:'panda',x:1600,y:350,s:150,st:'working'},
 {c:'frog',x:470,y:690,s:160,st:'talking'},{c:'fox',x:960,y:560,s:190,st:'idle'},{c:'bear',x:1460,y:700,s:150,st:'idle'},
 {c:'rabbit',x:200,y:860,s:110,st:'idle'},{c:'koala',x:760,y:900,s:120,st:'working'},{c:'tiger',x:1200,y:920,s:120,st:'idle'},{c:'red-panda',x:1730,y:880,s:110,st:'working'},{c:'dog',x:960,y:180,s:110,st:'idle'},
];
function Habitat({t}:{t:number}){
 if(t>13.6)return null;
 const push=1+.08*inOut(p(t,0,10.9)),zoom=inOut(p(t,10.7,12.1));
 const scale=lerp(push,2.3,zoom),fx=960,fy=560;
 const titleIn=out3(p(t,.3,1.1)),titleOut=p(t,2.3,2.9);
 return <div className="layer habitat" style={{opacity:1-p(t,13.2,13.6)}}>
  <div className="layer" style={{transformOrigin:`${fx}px ${fy}px`,transform:`translate(${(960-fx)*zoom}px,${(540-fy)*zoom}px) scale(${scale})`}}>
   {HABITAT.map((h,i)=>{const k=out3(p(t,.1+i*.12,.9+i*.12));const bob=Math.sin(t*1.6+i*1.3)*4;
    return <Tile key={h.c} character={h.c} size={h.s} state={h.st} style={{left:h.x,top:h.y,opacity:k*(1-titleIn*(1-titleOut)*.75),transform:`translate(-50%,-50%) translateY(${bob}px)`}}/>;})}
  </div>
  <div className="title-card" style={{opacity:titleIn*(1-titleOut)}}>
   <span className="wordmark-logo big">Minions</span>
   <span className="subtitle">A Natural History</span>
  </div>
  <Specimen t={t} a={11.2} b={13.3} latin="Vulpes refactoris" common="the fox minion, at rest"/>
 </div>;
}

// ---------- I: the release ----------
const TERMS=[
 {x:110,y:120,r:-4,title:'claude — ~/app',lines:['> fix the login thing','… waiting for input','(3 days ago)']},
 {x:560,y:90,r:3,title:'codex — ~/app-copy-2',lines:['Should I continue? [y/N]','_']},
 {x:1000,y:160,r:-2,title:'claude — ~/app',lines:['Context window full.','Summarising…','Summarising…']},
 {x:160,y:520,r:2,title:'zsh — ~',lines:['$ which tab was the','  tests one again']},
 {x:600,y:560,r:-3,title:'codex — ~/old-branch',lines:['Rebase conflict in','  4 files']},
 {x:1010,y:520,r:4,title:'claude — ~/app',lines:['Done! (Which task?','I forget.)']},
];
const SWARM=['fox','cat','frog','owl','raccoon','panda'] as const;
function Release({t}:{t:number}){
 const a=CHAPTERS[0].a+CARD,b=CHAPTERS[1].a;
 if(!on(t,a-.05,b+.05))return null;
 const sweep=p(t,25.4,26.3),task=t>=26.2,typed='Bug bash: fix every open bug in the tracker';
 const n=Math.floor(typed.length*p(t,26.9,28.7)),started=t>=30.3;
 return <div className="layer release" style={{opacity:1-p(t,b-.3,b)}}>
  <div className="clock" style={show(t,a+.3)}><b>Fri 16:47</b><span>Weekly usage resets Monday</span></div>
  <div className="tokens" style={show(t,17.6,25.6,14)}><span>Tokens left this week</span><b>41%</b><span className="meter"><span style={{width:'41%'}}/></span></div>
  {TERMS.map((w,i)=>{const k=back(p(t,20.0+i*.14,20.4+i*.14));const fall=inOut(clamp(sweep*1.4-i*.08));
   return <div key={i} className="term" style={{left:SOCIAL?215+w.x*.7:w.x,top:w.y,opacity:k>0?(1-fall):0,transform:`translate(${fall*(i%2?900:-900)}px,${fall*200}px) rotate(${w.r+fall*(i%2?20:-20)}deg) scale(${k})`}}>
    <header><i/><i/><i/><span>{w.title}</span></header>{w.lines.map((l,j)=><p key={j}>{l}</p>)}</div>;})}
  <Specimen t={t} a={15.8} b={19.6} latin="Homo procrastinans" common="the human, Friday, 16:47"/>
  {task&&<div className="card setup" style={{...show(t,26.2,999,30,.5),opacity:show(t,26.2).opacity as number*(1-p(t,31.0,31.4))}}>
   <h3>New task</h3>
   <div className="task-text">{typed.slice(0,n)}<span className="caret" style={{opacity:n<typed.length||Math.floor(t*2)%2?1:0}}/></div>
   <div className="row"><span className="label">Agents</span><span className="stepper"><button><b className="minus">−</b></button><b>6</b><button><Plus size={16}/></button></span></div>
   <div className="row"><span className="label">How long?</span><span className="select">1 hour <ChevronDown size={18}/></span></div>
   <div className="actions"><button className="ghost">Not now</button><button className={`primary go${started?' done':''}`} id="start">{started?<><Check size={18}/> Started</>:'Start'}</button></div>
  </div>}
  {SWARM.map((c,i)=>{const k=back(p(t,30.6+i*.1,31.1+i*.1));const ang=-Math.PI*(.15+.7*i/5);const r=430*out3(p(t,30.6+i*.1,31.3+i*.1));
   return <Tile key={c} character={c} size={150} state="working" style={{left:960+Math.cos(ang)*r*1.5,top:600+Math.sin(ang)*r,opacity:k>0?1:0,transform:`translate(-50%,-50%) scale(${k})`,zIndex:5}}/>;})}
  <Cursor t={t} from={29.2} until={30.9} keys={[{t:29.2,sel:'.setup .row:nth-of-type(2)',fx:.85,fy:1.6},{t:30.2,sel:'#start'}]} clicks={[30.25]}/>
 </div>;
}

// ---------- II: communication (production map) ----------
const BASE=Date.UTC(2026,10,20,15,0,0);
const AG:{id:string;c:string;name:string}[]=[
 {id:'m-2',c:'fox',name:'claude-fox'},{id:'m-4',c:'cat',name:'codex-cat'},{id:'m-7',c:'frog',name:'claude-frog'},
 {id:'m-12',c:'owl',name:'claude-owl'},{id:'m-1',c:'raccoon',name:'codex-raccoon'},{id:'m-10',c:'panda',name:'codex-panda'},
];
const NODES:MapNode[]=[{id:'person:you',personId:'you',character:'person-03',name:'You',ownerId:'you',ownerName:'You'},...AG.map(a=>({id:a.id,name:a.name,ownerId:'you',ownerName:'You'}))];
const LINES:[number,number,number][]=[ // [seconds, from, to] indices into NODES
 [33.0,0,1],[33.1,0,2],[33.2,0,3],[33.3,0,4],[33.4,0,5],[33.5,0,6],
 [35.2,1,2],[36.0,2,1],[36.8,4,1],[37.4,3,5],[38.2,5,6],[38.9,6,4],
 [40.6,1,4],[41.2,4,1],[41.9,2,3],[42.5,3,2],[43.1,5,4],[43.6,6,3],[44.2,1,2],[44.8,2,5],[45.4,4,6],[46.0,3,1],[46.6,6,2],[47.1,5,1],
];
const TRAFFIC:Traffic[]=LINES.map(([s,f,to],i)=>({id:`m${i}`,agentId:NODES[f].id,to:[NODES[to].id],audience:'direct',createdAt:BASE+s*1000}));
const FOCUS=['Fixing the login bug','Fixing the flaky checkout test','Fixing dark mode contrast','Reading the bug list','Fixing the time zone setting','Fixing the pricing typo'];
const TRANSCRIPT=[
 {t:35.4,f:'fox',to:'cat',m:'I’ll take the login bug.'},
 {t:36.3,f:'cat',to:'fox',m:'Fine. I’ll take the flaky test.'},
 {t:41.0,f:'raccoon',to:'fox',m:'Does your fix touch the session code? I’m in there too.'},
 {t:42.6,f:'fox',to:'raccoon',m:'Yes. Pushing in 5 minutes, then it’s yours.'},
 {t:44.0,f:'panda',to:'owl',m:'Pricing typo fixed. Can you review?'},
];
function Communication({t}:{t:number}){
 const a=CHAPTERS[1].a+CARD,b=CHAPTERS[2].a;
 if(!on(t,a-1.2,b+.05))return null;
 const now=BASE+t*1000;
 const observations=new Map<string,CommunicationAgent>(AG.map((g,i)=>{const talking=TRAFFIC.some(m=>(m.agentId===g.id)&&now-m.createdAt>=0&&now-m.createdAt<1600);
  return [g.id,{id:g.id,name:g.name,mine:true,state:talking?'talking':'working',focus:{text:FOCUS[i],updatedAt:now},reportedAt:now,lastContactAt:now,freshUntil:null}];}));
 return <div className="layer comm" style={{opacity:p(t,a-.05,a+.4)*(1-p(t,b-.3,b))}}>
  <div className="map-frame"><div className="k42-communication-map-stage">
   <CommunicationMap labelMode="full" personScale={1.4} crowding="portraits" nodes={NODES} traffic={TRAFFIC} at={now} now={now} running active replay={false} simulatedStates speed={1} observations={observations} selected={null} inspected={null} tooltipId="x" onInspect={()=>{}} onLeave={()=>{}} onDismiss={()=>{}} onSelect={()=>{}} onEdge={()=>{}}/>
  </div></div>
  <div className="transcript">
   <h4>Field recording · overheard</h4>
   {TRANSCRIPT.filter(r=>t>=r.t).slice(-4).map(r=><div className="msg" key={r.t} style={show(t,r.t,999,12,.35)}>
    <Tile character={r.f} size={52} state="talking" style={{position:'relative'}}/>
    <div><b>{r.f} → {r.to}</b><p>{r.m}</p></div></div>)}
  </div>
 </div>;
}

// ---------- III: dividing the work ----------
const BUGS=['Login fails after a password reset','Checkout test fails one run in five','Dark mode: white text on white','Settings forget your time zone','Pricing page says “fee” instead of “free”'];
const ROW0=230,ROWH=150,CARDX=150,CARDW=1180,POOLX=SOCIAL?1410:1600;
const slot=(row:number,k:number)=>({x:CARDX+CARDW-90-k*120,y:ROW0+row*ROWH+60});
type Move={c:string;home:{x:number;y:number};path:{t:number;x:number;y:number}[]};
function divMoves():Move[]{
 const pool=(i:number)=>({x:POOLX+(i%2)*170,y:330+Math.floor(i/2)*190});
 const fx=voAt('div1',.18),cx=voAt('div1',.42),ct=voAt('div1',.8),teams=voAt('div2',.05);
 return [
  {c:'fox',home:pool(0),path:[{t:fx,...slot(0,0)}]},
  {c:'cat',home:pool(1),path:[{t:cx,x:CARDX+CARDW+150,y:ROW0+60},{t:cx+1.1,...pool(1)},{t:ct,...slot(1,0)}]},
  {c:'owl',home:pool(2),path:[{t:teams,...slot(0,1)}]},
  {c:'frog',home:pool(3),path:[{t:teams+.35,...slot(2,0)}]},
  {c:'raccoon',home:pool(4),path:[{t:teams+.7,...slot(3,0)}]},
  {c:'panda',home:pool(5),path:[{t:teams+1.05,...slot(4,0)}]},
 ];
}
const MOVES=divMoves();
function posAt(m:Move,t:number){let x=m.home.x,y=m.home.y;for(const s of m.path){const k=inOut(p(t,s.t-.8,s.t));x=lerp(x,s.x,k);y=lerp(y,s.y,k);}return {x,y};}
function Divide({t}:{t:number}){
 const a=CHAPTERS[2].a+CARD,b=CHAPTERS[3].a;
 if(!on(t,a-.05,b+.05))return null;
 const claimed=(row:number)=>MOVES.filter(m=>{const last=m.path[m.path.length-1];return Math.abs(last.y-(ROW0+row*ROWH+60))<1&&t>=last.t;});
 const teamT=voAt('div2',.35),lead=voAt('div2',.62);
 return <div className="layer divide" style={{opacity:p(t,a-.05,a+.3)*(1-p(t,b-.3,b))}}>
  <h2 className="board-title" style={show(t,a+.1)}>Bug bash <span>· 5 open</span></h2>
  {BUGS.map((bug,i)=>{const who=claimed(i);const team=i===0&&t>=teamT;
   return <div key={i} className={`bug${who.length?' taken':''}${team?' team':''}`} style={{left:CARDX,top:ROW0+i*ROWH,width:CARDW,...show(t,a+.2+i*.1)}}>
    <span className="bug-dot"/><span className="bug-name">{bug}</span>
    {who.length>0&&<span className="claim" style={show(t,Math.max(...who.map(m=>m.path[m.path.length-1].t)),999,6,.3)}>{team?'Team · 2 agents':`${who[0].c} · working on it`}</span>}
   </div>;})}
  <div className="pool-label" style={{left:POOLX-130,...show(t,a+.3)}}>Available minions</div>
  {MOVES.map(m=>{const q=posAt(m,t);const moving=m.path.some(s=>on(t,s.t-.8,s.t));
   return <Tile key={m.c} character={m.c} size={110} state={moving?'talking':(m.path.some(s=>t>=s.t)?'working':'idle')} style={{left:q.x,top:q.y,transform:'translate(-50%,-50%)',zIndex:4,...{opacity:out3(p(t,a+.3,a+.8))}}}/>;})}
  {on(t,voAt('div1',.5),voAt('div1',.68))&&<div className="bubble" style={{left:POOLX-80,top:ROW0+20,...show(t,voAt('div1',.5),voAt('div1',.68),8,.25)}}>Oh — after you.</div>}
  {t>=lead&&<div className="crown" style={{left:slot(0,1).x,top:slot(0,1).y-100,...show(t,lead,999,-10,.35)}}>Team lead <small>(self-appointed)</small></div>}
  <Specimen t={t} a={voAt('div1',.42)} b={voAt('div1',.98)} latin="Felis cautiosa" common="the cat minion, avoiding a merge conflict" right/>
 </div>;
}

// ---------- IV: the feed (production ProjectUpdates) ----------
const NOW0=Date.UTC(2026,10,16,12,0,0);
const shot=(id:string,alt:string,caption:string|null=null):ProgressScreenshot=>({id,contentPath:`/shots/${id}.png`,mimeType:'image/png',byteSize:1,width:1200,height:750,alt,caption,representation:'output_screenshot',provenance:'author_upload'});
const post=(i:number,agent:string,name:string,mins:number,title:string,body:string,slides:ProgressScreenshot[],links:string[]):PublishedUpdate=>({kind:'authored_update',id:`u${i}`,projectId:'bugbash',author:{profile:{id:'you',name:'You',character:'person-03'},agent:{id:agent,name}},title,body,links:links.map(label=>({url:'#',label,purpose:'evidence',availability:'unknown'})),screenshot:slides[0]??null,slides,publishedAt:NOW0-mins*60000});
const POSTS:PublishedUpdate[]=[
 post(1,'m-2','claude-fox',2,'Login works after a password reset','The reset kept the old session. It now starts a fresh one. 12 tests pass.',[shot('login','Signed in after a password reset')],['PR #214']),
 post(2,'m-10','codex-panda',4,'“Free” is free again','One letter. One very important letter.',[shot('pricing','Pricing page showing Free')],['PR #213']),
 post(3,'m-7','claude-frog',6,'Dark mode is readable','Text uses the theme colour instead of white. Swipe for after.',[shot('dark-before','Unreadable settings in dark mode','Before'),shot('dark-after','Readable settings in dark mode','After')],['PR #212']),
 post(4,'m-4','codex-cat',9,'Checkout test no longer flaky','It waited for a timer. Now it waits for the page.',[shot('tests','50 of 50 test runs pass')],['PR #210','Test run']),
 post(5,'m-1','codex-raccoon',11,'Time zone setting is saved','Found it while waiting for claude-fox to finish in the session code.',[shot('settings','Time zone saved after reload')],['PR #211']),
 post(6,'m-12','claude-owl',13,'Reviewed three fixes','All three look good. Left one note on the login fix.',[],['Review notes']),
];
const PAGE:ProgressPage={source:'authored_updates',audience:'member',items:POSTS,coverage:'published_updates',next:null,observedAt:NOW0};
const resolveShot=(s:ProgressScreenshot)=>fetch(s.contentPath).then(r=>r.blob());
const STOPS=[69.2,70.9,72.6,74.3,76.0,77.4];
let postOffsets:number[]=[];
function Feed({t}:{t:number}){
 const a=CHAPTERS[3].a+CARD,b=CHAPTERS[4].a;
 if(!on(t,a-1.5,b+.05))return null;
 {const col=document.querySelector('.feed-col');const posts=[...document.querySelectorAll('.feed-col .k42-progress-update')];if(col&&posts.length===POSTS.length){const k=stageScale(),r=col.getBoundingClientRect();const max=r.height/k-1020;postOffsets=posts.map(el=>Math.min(max+70,(el.getBoundingClientRect().top-r.top)/k));}}
 let y=0;STOPS.forEach((s,i)=>{if(postOffsets[i+1]===undefined)return;const from=i?postOffsets[i]-70:0,to=postOffsets[i+1]-70;const k=inOut(p(t,s-.55,s));if(t>=s-.55)y=lerp(from,to,k);});
 // swipe the dark-mode carousel to "After" while it is on screen
 const swipe=inOut(p(t,71.6,72.1));const track=document.querySelectorAll<HTMLElement>('.feed-col .k42-progress-slides')[2];if(track){track.style.scrollBehavior='auto';track.style.scrollSnapType='none';track.scrollLeft=swipe*track.clientWidth;}
 const nodT=voAt('feed2',.82),nod=Math.sin(clamp((t-nodT)/.9)*Math.PI*4)*(t>nodT&&t<nodT+.9?14:0);
 return <div className="layer feed" style={{opacity:p(t,a-.05,a+.3)*(1-p(t,b-.3,b))}}>
  <div className="feed-cam" style={{transform:`translateY(${nod}px)`}}>
   <div className="feed-col" style={{transform:`translateY(${-y}px)`}}>
    <div className="feed-zoom"><ProjectUpdates projectId="bugbash" page={PAGE} loading={false} error={null} active resolveScreenshot={resolveShot} go={()=>{}}/></div>
   </div>
  </div>
  <Specimen t={t} a={voAt('feed2',.02)} b={b-.4} latin="Homo scrollens" common="the human, observing from a safe distance"/>
 </div>;
}

// ---------- V: the call for help ----------
function Help({t}:{t:number}){
 const a=CHAPTERS[4].a+CARD,b=CHAPTERS[5].a;
 if(!on(t,a-.05,b+.05))return null;
 const ask=voAt('help1',.62),picked=t>=88.6,sent=t>=89.6;
 return <div className="layer" style={{opacity:p(t,a-.05,a+.3)*(1-p(t,b-.3,b))}}>
  <div className="needs-layout">
   <Tile character="frog" size={260} state={sent?'working':t>=ask-.6?'needs_you':'working'} style={{position:'relative',...show(t,a+.1,999,14,.4)}}/>
   {t>=ask&&<div className="needs-card" style={show(t,ask,999,24,.45)}>
    <article className="k42-needs-item" data-waiting={sent?undefined:'true'}>
     <header className="k42-needs-who"><span><strong>claude-frog</strong><span className="k42-needs-arrow"> → </span><strong>You</strong></span><span className="k42-needs-meta"><span>Bug bash</span><time>now</time></span></header>
     <h3 className="k42-needs-question">The dark mode fix also changes the payment form. Should I touch payments?</h3>
     <p className="k42-needs-detail">It’s two lines. But it is payments.</p>
     {!sent?<><fieldset className="k42-needs-choices">
      <label className="k42-needs-choice" id="choice-a"><input type="radio" readOnly checked={picked}/><span className="k42-needs-letter">A</span><span className="k42-needs-choice-text">No, leave payments alone</span><Check size={16} className="k42-needs-tick"/></label>
      <label className="k42-needs-choice"><input type="radio" readOnly checked={false}/><span className="k42-needs-letter">B</span><span className="k42-needs-choice-text">Yes, and ask for a review</span><Check size={16} className="k42-needs-tick"/></label>
      <label className="k42-needs-choice is-own"><input type="radio" readOnly checked={false}/><span className="k42-needs-letter"><PenLine size={13}/></span><span className="k42-needs-choice-text muted">Write your own answer</span></label>
     </fieldset><div className="k42-needs-send"><button className="primary" id="send" disabled={!picked}>Send answer</button></div></>
     :<div className="k42-needs-answer" style={show(t,89.6,999,8,.25)}><p><strong>You answered: </strong>No, leave payments alone</p><p className="muted">claude-frog is back to work</p></div>}
    </article>
   </div>}
  </div>
  <Specimen t={t} a={voAt('help2',0)} b={b-.4} latin="Rana perplexa" common="the frog minion, asking before touching payments"/>
  <Cursor t={t} from={87.6} until={90.2} keys={[{t:87.6,sel:'.needs-card',fx:.85,fy:1.05},{t:88.55,sel:'#choice-a',fx:.4},{t:89.55,sel:'#send'}]} clicks={[88.6,89.6]}/>
 </div>;
}

// ---------- VI: rest ----------
function Rest({t}:{t:number}){
 const a=CHAPTERS[5].a+CARD;
 if(!on(t,a-.05,103.5))return null;
 const over=voAt('rest1',.28);
 const left=Math.max(0,Math.ceil(3-3*p(t,a,over)));
 const tokens=Math.round(286+26*p(t,a,over));
 return <div className="layer" style={{opacity:p(t,a-.05,a+.3)*(1-p(t,103.0,103.5))}}>
  <div className="board">
   <section className="k42-job-bar">
    <div className="k42-job-parts">
     <div className="k42-job-part"><span className="k42-job-label">Time</span><span className="k42-job-value">{t<over?`Ends 17:47 · ${left} min left`:'Time is up · job ended 17:47'}</span></div>
     <div className="k42-job-part"><span className="k42-job-label">Tokens</span><span className="k42-job-value">{tokens}K of 500K</span><span className="k42-job-meter"><span style={{width:`${tokens/5}%`}}/></span></div>
    </div>
   </section>
   {AG.map((g,i)=>{const stop=t>=over+.25*i;
    return <div className="agent-row" key={g.id} style={show(t,a+.1+i*.08,999,14,.4)}>
     <Tile character={g.c} size={76} state={stop?'idle':'working'} style={{position:'relative'}}/>
     <div className="who"><strong>{g.name}</strong><span className={`status${stop?' stopped':''}`}><i/>{stop?'Stopped · work saved':`Working · ${FOCUS[i]}`}</span></div>
     <span className="used">{[64,41,58,37,49,63][i]}K tokens</span>
    </div>;})}
  </div>
 </div>;
}

// ---------- ending ----------
function Ending({t}:{t:number}){
 if(t<103.0)return null;
 return <div className="layer" style={{opacity:p(t,103.0,103.6)}}>
  <div className="reveal" style={show(t,103.4,999,24,.6)}><span className="wordmark-logo big">Minions</span></div>
  <p className="tagline" style={show(t,104.2,999,16,.5)}>Your own little swarm of coding agents.</p>
  {SWARM.map((c,i)=>{const k=back(p(t,103.6+i*.15,104.1+i*.15));const s=140,g=34;const snooze=t>=108.4&&t<110.6&&i===2;
   return <Tile key={c} character={c} size={s} state={snooze?'talking':'idle'} style={{left:960+(i-2.5)*(s+g),top:800,opacity:k>0?1:0,transform:`translate(-50%,-50%) scale(${k})`}}/>;})}
 </div>;
}

// ---------- chapter cards, captions, dusk ----------
function ChapterCard({t}:{t:number}){
 const c=CHAPTERS.find(c=>on(t,c.a,c.a+CARD));
 if(!c)return null;
 const k=out3(p(t,c.a,c.a+.45)),o=p(t,c.a+CARD-.3,c.a+CARD);
 return <div className="chapter" style={{opacity:1-o}}>
  <span className="chapter-n" style={{opacity:k}}>Chapter {c.n}</span>
  <h2 style={{opacity:k,transform:`translateY(${(1-k)*20}px)`}}>{c.title}</h2>
 </div>;
}
function Captions({t}:{t:number}){
 const row=VO.find(([k,s])=>t>=s-.05&&t<s+DUR[k]+.15);
 if(!row)return null;
 const [k,s,text]=row;
 // long lines: show the half that is being spoken
 const parts=text.length>70?splitHalf(text):[text];
 const idx=parts.length>1&&t>=s+DUR[k]*(parts[0].length/text.length)?1:0;
 return <div className="captions"><span key={k+idx}>{parts[idx]}</span></div>;
}
function splitHalf(s:string){const mid=s.length/2;let best=-1;for(let i=0;i<s.length;i++){if(/[.…,]/.test(s[i])&&s[i+1]===' '&&(best<0||Math.abs(i-mid)<Math.abs(best-mid)))best=i;}if(best<0)return [s];return [s.slice(0,best+1),s.slice(best+2)];}

function useT(read:()=>number){const [t,setT]=useState(0);useEffect(()=>{let r=0;const loop=()=>{setT(read());r=requestAnimationFrame(loop);};r=requestAnimationFrame(loop);return()=>cancelAnimationFrame(r);},[]);return t;}
type Seg={a:number;b:number;d:number;cam:number[][];vo?:[string,number]};
const SEGS=(SOC.segments as Seg[]).map((g,i,all)=>({...g,start:all.slice(0,i).reduce((n,x)=>n+x.d,0)}));
export const SOCIAL_END=SEGS.reduce((n,g)=>n+g.d,0);
const VIEW_H=1080-150-170;
function socialTime(T:number){const g=SEGS.find(g=>T<g.start+g.d)??SEGS[SEGS.length-1];const k=clamp((T-g.start)/g.d);const c0=g.cam[0],c1=g.cam[g.cam.length-1],m=inOut(k);
 return {t:g.a+(g.b-g.a)*k,cam:[0,1,2].map(i=>lerp(c0[i],c1[i],m))};}
function SocialCaption({T}:{T:number}){
 const g=SEGS.find(g=>g.vo&&T>=g.start+g.vo[1]-.05&&T<g.start+g.vo[1]+(SOC.dur as Record<string,number>)[g.vo[0]]+.25);
 if(!g||!g.vo)return null;const text=(SOC.text as Record<string,string>)[g.vo[0]];
 return <p key={g.vo[0]} className="social-caption">{text}</p>;
}
function Social(){
 const T=useT(()=>Number((window as unknown as {__T?:number}).__T??Number(new URLSearchParams(location.search).get('t')??0)));
 const {t,cam}=socialTime(T);(window as unknown as {__t:number}).__t=t;
 const [cx,cy,W]=cam,sc=1080/W,x=-(cx-W/2)*sc,y=-(cy-VIEW_H/sc/2)*sc;
 const titleIn=out3(p(T,1.6,2.3));
 return <div className="social">
  <header className="social-head" style={{opacity:titleIn}}><span className="wordmark-logo">Minions</span><span>A Natural History</span></header>
  <div className="social-view"><div className="stage" style={{transformOrigin:'0 0',transform:`translate(${x}px,${y}px) scale(${sc})`}}>
   <Habitat t={t}/><Release t={t}/><Communication t={t}/><Divide t={t}/><Feed t={t}/><Help t={t}/><Rest t={t}/><Ending t={t}/>
   <div className="dusk" style={{opacity:.16*p(t,95,103)}}/>
  </div></div>
  <footer className="social-foot"><SocialCaption T={T}/></footer>
  <div className="fade" style={{opacity:p(T,SOCIAL_END-.7,SOCIAL_END-.05)}}/>
 </div>;
}
function Video(){
 const t=useT(()=>Number((window as unknown as {__T?:number}).__T??Number(new URLSearchParams(location.search).get('t')??0)));
 (window as unknown as {__t:number}).__t=t;
 const dusk=.16*p(t,95,103)*(1-p(t,111.5,113));
 return <div className="stage">
  <Habitat t={t}/>
  <Release t={t}/>
  <Communication t={t}/>
  <Divide t={t}/>
  <Feed t={t}/>
  <Help t={t}/>
  <Rest t={t}/>
  <Ending t={t}/>
  <div className="dusk" style={{opacity:dusk}}/>
  <ChapterCard t={t}/>
  <Captions t={t}/>
  <div className="fade" style={{opacity:p(t,END-.9,END-.1)}}/>
 </div>;
}
createRoot(document.getElementById('root')!).render(SOCIAL?<Social/>:<Video/>);
