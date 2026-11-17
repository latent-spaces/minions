import type {Traffic} from './layout.js';
export type TrafficPage={at:number;from:number;traffic:(Traffic&{id:string})[];next:string|null;serverTime:number};
/** The last complete traffic read: its frame time, the frame's trafficMark and its rows. */
export type TrafficRead={at:number;mark:string|null;rows:Traffic[]};
/** A frame refresh at most this long after the last traffic read may reuse it when nothing new arrived. */
export const TRAFFIC_REUSE_MS=60_000;
/** Rows for a newer frame whose newest shared message (trafficMark) is the one already read: the last read minus
 * rows that left the five-minute window. Null asks for a fresh read (new message, no mark, older frame, or stale). */
export function reuseTraffic(last:TrafficRead|null,at:number,mark:string|null|undefined,now=at):Traffic[]|null{
 if(!last||mark===undefined||mark!==last.mark||at<last.at||now-last.at>=TRAFFIC_REUSE_MS)return null;
 const from=Math.max(0,Math.floor(at)-300000);
 return last.rows.filter(row=>row.createdAt>=from&&row.createdAt<=at);
}
/** Publish complete frames only; bounded even if a client supplies endless cursors. */
export async function readTrafficFrame(at:number,read:(query:string)=>Promise<TrafficPage>):Promise<Traffic[]>{
 let cursor:string|null=null;const seen=new Set<string>(),messages=new Map<string,Traffic>();
 for(let page=0;page<20;page++){
  const params=new URLSearchParams({at:String(Math.floor(at))});if(cursor)params.set('cursor',cursor);
  const frame=await read(params.toString());
  if(frame.at!==Math.floor(at)||frame.from!==Math.max(0,Math.floor(at)-300000))throw Error('Graph frame changed while loading');
  for(const m of frame.traffic){if(m.createdAt<frame.from||m.createdAt>frame.at)throw Error('Graph metadata outside frame');messages.set(m.id,{id:m.id,agentId:m.agentId,to:m.to,audience:m.audience,createdAt:m.createdAt});}
  if(!frame.next)return [...messages.values()];
  if(seen.has(frame.next))throw Error('Repeated graph cursor');seen.add(frame.next);cursor=frame.next;
 }
 throw Error('Graph traffic exceeds this view’s bounded capacity');
}

/** The existing /threads/:id reader accepts any shared message ID and resolves
 * its thread. Reuse that for people and agents, without adding bodies to traffic. */
export function connectionMessageId(rows:Traffic[],from:string,to:string,at=Infinity):string|null {
 let latest:Traffic|undefined;
 for(const row of rows)if(row.id&&row.createdAt<=at&&row.audience==='direct'&&row.agentId===from&&row.to.includes(to)&&(!latest||row.createdAt>latest.createdAt))latest=row;
 return latest?.id??null;
}
