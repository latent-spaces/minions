export type Traffic = {id?:string;agentId:string; to:string[]; audience:string; createdAt:number};
export type Link = {from:string; to:string; count:number; latestAt:number; weight:number};
export const HALF_LIFE = 15_000, EDGE_CUTOFF = 45_000, EDGE_MIN_WEIGHT = .015, SEPARATION = 104;
// Input arrays are immutable scenario metadata. Index once, including unsorted
// callers, then visit only the selected window. Seeks remain independent of history.
const chronological=new WeakMap<Traffic[],Traffic[]>();
export function communicationWeights(messages:Traffic[], at:number, halfLife=HALF_LIFE, windowMs=300_000,cutoffMs=EDGE_CUTOFF):Link[] {
  if(!Number.isFinite(halfLife)||halfLife<=0||!Number.isFinite(cutoffMs)||cutoffMs<=0)throw Error('Choose positive finite decay and cutoff durations');
  if(windowMs!==120_000&&windowMs!==300_000)throw Error('Choose a two- or five-minute window');
  const pairs=new Map<string,Link>();
  let ordered=chronological.get(messages);
  if(!ordered){ordered=[...messages].sort((a,b)=>a.createdAt-b.createdAt);chronological.set(messages,ordered);}
  let lo=0,hi=ordered.length;
  while(lo<hi){const mid=(lo+hi)>>>1;if(ordered[mid].createdAt<at-Math.min(windowMs,cutoffMs))lo=mid+1;else hi=mid;}
  for(let i=lo;i<ordered.length&&ordered[i].createdAt<=at;i++){
    const m=ordered[i],age=at-m.createdAt;
    if(age<0 || age>windowMs || age>=cutoffMs || m.audience!=='direct')continue;
    const weight=2**(-age/halfLife); if(weight<.001)continue;
    for(const to of new Set(m.to)){if(to===m.agentId)continue;
      const key=JSON.stringify([m.agentId,to]), old=pairs.get(key);
      if(old){old.weight+=weight;old.count++;old.latestAt=Math.max(old.latestAt,m.createdAt);}
      else pairs.set(key,{from:m.agentId,to,count:1,latestAt:m.createdAt,weight});
    }
  }
  return [...pairs.values()];
}
export function initialPositions(n:number):Float64Array {
  const y=new Float64Array(n*2);
  for(let i=0;i<n;i++){const angle=i*Math.PI*(3-Math.sqrt(5)),radius=68*Math.sqrt(i);y[2*i]=Math.cos(angle)*radius;y[2*i+1]=Math.sin(angle)*radius;}
  separate(y);return y;
}
/** Collision projection for initial packing only. Ongoing motion uses soft forces. */
export function separate(y:Float64Array,passes=8,min=SEPARATION+2) {
  for(let pass=0;pass<passes;pass++){
    const cells=new Map<string,number[]>();let overlap=0;
    for(let i=0;i<y.length/2;i++){
      const cx=Math.floor(y[2*i]/min),cy=Math.floor(y[2*i+1]/min);
      for(let x=cx-1;x<=cx+1;x++)for(let v=cy-1;v<=cy+1;v++)for(const j of cells.get(x+','+v)??[]){
        let dx=y[2*i]-y[2*j],dy=y[2*i+1]-y[2*j+1],distance=Math.hypot(dx,dy);
        if(distance>=min)continue;if(distance<1e-9){dx=1;dy=0;distance=1;}
        const correction=(min-distance)/2+.0001;y[2*i]+=dx/distance*correction;y[2*i+1]+=dy/distance*correction;y[2*j]-=dx/distance*correction;y[2*j+1]-=dy/distance*correction;overlap++;
      }
      // Positions may have crossed a cell boundary during projection.
      const key=Math.floor(y[2*i]/min)+','+Math.floor(y[2*i+1]/min);const bucket=cells.get(key)??[];bucket.push(i);cells.set(key,bucket);
    }
    if(!overlap)break;
  }
  return y;
}
