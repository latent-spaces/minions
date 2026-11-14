import {useEffect,useRef,useState} from 'react';
import {useSample,type Snapshot} from './sample';
export const treatments=[
 {id:'fill',name:'Use map bounds',detail:'Fill the available map bounds. Hide all colliding text, including names; inspect a portrait for details.'},
 {id:'current',name:'Previous layout',detail:'Previous fitting with all names, statuses and focus lines.'},
 {id:'names',name:'Names first',detail:'Keep names and state bubbles. Move status and focus text into agent details.'},
 {id:'smart',name:'Avoid label collisions',detail:'Names first, then hide names that overlap portraits or other names. Tap for details.'},
 {id:'inspect',name:'Details on tap',detail:'Portraits and state bubbles only. Reveal the name on hover, focus or selection.'},
] as const;
export type Treatment=typeof treatments[number]['id'];
function Pane({phone,snapshot,treatment}:{phone:boolean;snapshot:Snapshot;treatment:Treatment}){
 const frame=useRef<HTMLIFrameElement>(null),host=useRef<HTMLDivElement>(null),[width,setWidth]=useState(phone?390:640);
 const latest=useRef({snapshot,treatment});latest.current={snapshot,treatment};
 const update=()=>frame.current?.contentWindow?.postMessage({type:'lab-snapshot',...latest.current},location.origin);
 useEffect(update,[snapshot.at,snapshot.playing,snapshot.messages,treatment]);
 useEffect(()=>{const ready=(event:MessageEvent)=>{if(event.origin===location.origin&&event.source===frame.current?.contentWindow&&event.data?.type==='lab-ready')update();};window.addEventListener('message',ready);return()=>window.removeEventListener('message',ready);},[]);
 useEffect(()=>{if(phone)return;const observer=new ResizeObserver(([entry])=>setWidth(Math.round(entry.contentRect.width)));observer.observe(host.current!);return()=>observer.disconnect();},[phone]);
 return <section className={`review-pane${phone?' is-phone':''}`}><div className="review-pane-title"><h2>{phone?'Phone':'Full map'}</h2><span>{width} × {phone?844:680} viewport · 100%</span></div><p>{phone?'Actual phone viewport with the app’s side-panel CSS.':'Expanded map in the available pane. Use Full screen to check the whole window.'}</p><div ref={host} className="review-frame"><iframe allowFullScreen ref={frame} title={phone?'Phone map':'Full map'} src={`/?embedded=1&device=${phone?'phone':'fullscreen'}`} onLoad={update} style={{width:phone?390:'100%',height:phone?844:680}}/></div></section>;
}
export default function Review(){
 const sample=useSample(true),[treatment,setTreatment]=useState<Treatment>('fill');
 const snapshot={at:sample.at,playing:sample.playing,messages:sample.messages};
 return <main className="map-review"><header><div><h1>Map review</h1><p>Same nine participants, messages and clock in both views. Synthetic data, production map.</p></div><div className="review-playback"><button onClick={()=>sample.setPlaying(value=>!value)}>{sample.playing?'Pause':'Play'}</button><button onClick={sample.send}>Send sample message</button></div></header>
 <div className="review-treatments" role="group" aria-label="Clutter treatment">{treatments.map(option=><button key={option.id} aria-pressed={treatment===option.id} onClick={()=>setTreatment(option.id)}>{option.name}</button>)}</div>
 <p className="review-description">{treatments.find(option=>option.id===treatment)!.detail} {treatment==='fill'?<strong>Selected product behavior.</strong>:<strong>Comparison only.</strong>}</p>
 <p className="review-status" role="status">{sample.playing?'Messages every 4 seconds':'Paused for comparison'} · {sample.messages.filter(message=>message.id.startsWith('new-')).length} new messages. No preview scaling; scroll horizontally on narrow windows.</p>
 <div className="review-scroll"><div className="review-pair"><Pane snapshot={snapshot} treatment={treatment} phone={false}/><Pane snapshot={snapshot} treatment={treatment} phone/></div></div>
 <section className="review-next"><h2>Suggested next step</h2><p>Compare “Use map bounds” against “Previous layout.” Positions fill each map’s usable rectangle; colliding text, including names, disappears. Portrait sizes and connections stay intact. Tap a portrait for its details.</p><p>Review portrait overlap and movement on the phone first, then resize or enter fullscreen. Filling each axis changes apparent distances; it does not change who is connected. If needed, add local portrait spacing next. The selected behavior is shared with the product map.</p></section>
 </main>;
}
