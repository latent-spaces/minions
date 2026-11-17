import type {Link} from './layout';

type Relationship = {a:number;b:number;strength:number;target:number};
const STEP = 1 / 60;
const COMFORT = 165, PERSONAL_SPACE = 144;
const MAX_ACCELERATION = 90, MAX_SPEED = 32, DRAG = 4;
const RING_GAP = 120, RING_SPACING = 90;

/** A visual layout with memory, not a continuously recomputed embedding.
 * Time is visible wall time in seconds, independent of replay speed. The same
 * solver handles 2D and 3D; projection and line appearance never affect physics. */
export class ConversationMotion {
  readonly y:Float64Array;
  readonly velocity:Float64Array;
  readonly bounds:number[];
  private readonly index:Map<string,number>;
  private readonly relationships = new Map<string,Relationship>();
  private readonly owners:number[][];
  private readonly sleeping:Uint8Array;
  private readonly quiet:Float64Array;
  private readonly ring:boolean[];
  private readonly agentsOf:number[][];
  private ringRadius = 0;

  /** `ringPeople` marks person nodes that sit on an outer ring facing their own agents. */
  constructor(ids:string[], seed:Float64Array, readonly dimensions:2|3, owners:(string|null|undefined)[] = [], ringPeople:boolean[] = []) {
    this.y = seed.slice();
    this.velocity = new Float64Array(seed.length);
    this.sleeping = new Uint8Array(ids.length);
    this.quiet = new Float64Array(ids.length);
    this.index = new Map(ids.map((id,i) => [id,i]));
    this.bounds = Array.from({length:dimensions},(_,d) => Math.max(300,...ids.map((_,i) => Math.abs(seed[i*dimensions+d])))+160);
    const groups = new Map<string,number[]>();
    this.ring = ids.map((_,i) => !!ringPeople[i]);
    owners.forEach((owner,i) => {if(owner && i<ids.length && !this.ring[i]){const members=groups.get(owner)??[];members.push(i);groups.set(owner,members);}});
    this.owners = [...groups.values()].filter(members => members.length>1);
    // A ring person's agents share its id as their owner id.
    this.agentsOf = ids.map((id,i) => this.ring[i] ? groups.get(owners[i] ?? id) ?? [] : []);
    // Start people on the ring rather than travelling out from the seed.
    for(const [i,target] of this.ringTargets(0))this.y.set(target,i*dimensions);
  }

  /** Ring positions: each person faces the centre of their agents; neighbours
   * are spread to a minimum arc and the radius eases with the agents' extent. */
  private ringTargets(dt:number) {
    const d=this.dimensions,n=this.y.length/d,people:number[]=[],agents:number[]=[];
    for(let i=0;i<n;i++)(this.ring[i]?people:agents).push(i);
    const targets=new Map<number,number[]>();
    if(!people.length) return targets;
    const center=[0,0];for(const i of agents)for(let axis=0;axis<2;axis++)center[axis]+=this.y[i*d+axis]/Math.max(1,agents.length);
    let extent=0;for(const i of agents)extent=Math.max(extent,Math.hypot(this.y[i*d]-center[0],this.y[i*d+1]-center[1]));
    const wanted=Math.max(extent+RING_GAP,people.length*RING_SPACING/(2*Math.PI));
    this.ringRadius=this.ringRadius?this.ringRadius+(wanted-this.ringRadius)*(1-Math.exp(-dt/3)):wanted;
    const angles=people.map((p,k) => {
      const own=this.agentsOf[p];if(!own.length) return {p,angle:k/people.length*2*Math.PI};
      const x=own.reduce((sum,i)=>sum+this.y[i*d],0)/own.length-center[0],y=own.reduce((sum,i)=>sum+this.y[i*d+1],0)/own.length-center[1];
      return {p,angle:Math.hypot(x,y)>1?Math.atan2(y,x):k/people.length*2*Math.PI};
    }).sort((a,b) => a.angle-b.angle||a.p-b.p);
    const gap=Math.min(2*Math.PI/angles.length,RING_SPACING/this.ringRadius);
    for(let pass=0;pass<8;pass++)for(let k=0;k<angles.length;k++){
      const a=angles[k],b=angles[(k+1)%angles.length],between=((b.angle-a.angle)%(2*Math.PI)+2*Math.PI)%(2*Math.PI)||(angles.length>1?0:2*Math.PI);
      if(between<gap){const push=(gap-between)/2;a.angle-=push;b.angle+=push;}
    }
    for(const {p,angle} of angles){const t=[center[0]+Math.cos(angle)*this.ringRadius,center[1]+Math.sin(angle)*this.ringRadius];if(d===3)t.push(0);targets.set(p,t);}
    return targets;
  }

  step(links:Link[], elapsedSeconds = .1) {
    for(const relationship of this.relationships.values()) relationship.target=0;
    // Physical relationships are undirected. Reply direction and message count
    // can change line appearance without making a settled pair rearrange.
    const weights = new Map<string,{a:number;b:number;weight:number}>();
    for(const link of links){
      const from=this.index.get(link.from),to=this.index.get(link.to);
      if(from===undefined || to===undefined || from===to) continue;
      const a=Math.min(from,to),b=Math.max(from,to),key=`${a}:${b}`,old=weights.get(key);
      weights.set(key,{a,b,weight:(old?.weight??0)+link.weight});
    }
    for(const [key,{a,b,weight}] of weights){
      const relationship=this.relationships.get(key)??{a,b,strength:0,target:0};
      relationship.target=1-Math.exp(-Math.max(0,weight));
      this.relationships.set(key,relationship);
    }
    // No catch-up after pause/hidden tabs, and bounded substeps after a slow frame.
    let remaining=Number.isFinite(elapsedSeconds)?Math.max(0,Math.min(.2,elapsedSeconds)):0;
    while(remaining>1e-8){const dt=Math.min(STEP,remaining);this.integrate(dt);remaining-=dt;}
    return {points:this.y.slice()};
  }

  private integrate(dt:number) {
    const d=this.dimensions,n=this.y.length/d,force=new Float64Array(this.y.length),engaged=new Float64Array(n),degree=new Float64Array(n);
    for(const [key,r] of this.relationships){
      r.strength+=(r.target-r.strength)*(1-Math.exp(-dt/(r.target>r.strength?1.2:4)));
      if(r.target===0 && r.strength<.001){this.relationships.delete(key);continue;}
      engaged[r.a]=Math.max(engaged[r.a],r.strength);engaged[r.b]=Math.max(engaged[r.b],r.strength);
      degree[r.a]+=r.strength;degree[r.b]+=r.strength;
    }
    const pair=(a:number,b:number,amount:number,distance:number) => {
      for(let axis=0;axis<d;axis++){
        // Deterministic escape for coincident seeds; no random frame noise.
        const direction=distance>1e-8?(this.y[b*d+axis]-this.y[a*d+axis])/distance:Number(axis===(a+b)%d);
        force[a*d+axis]+=direction*amount;force[b*d+axis]-=direction*amount;
      }
    };
    for(const r of this.relationships.values()){
      if(this.ring[r.a] || this.ring[r.b]) continue;
      let distance=0;for(let axis=0;axis<d;axis++)distance+=(this.y[r.a*d+axis]-this.y[r.b*d+axis])**2;distance=Math.sqrt(distance);
      // A broad resting band, not a new target distance on each message.
      if(distance>COMFORT) pair(r.a,r.b,2*(distance-COMFORT)*r.strength/Math.max(1,Math.sqrt(Math.max(degree[r.a],degree[r.b]))),distance);
    }
    // Local soft avoidance acts through acceleration, never a position projection.
    // Spatial cells keep the neighbourhood work bounded for large quiet rosters.
    const cells=new Map<string,number[]>();
    for(let i=0;i<n;i++){
      const cell=Array.from({length:d},(_,axis)=>Math.floor(this.y[i*d+axis]/PERSONAL_SPACE));
      for(let x=-1;x<=1;x++)for(let y=-1;y<=1;y++)for(let z=d===3?-1:0;z<=(d===3?1:0);z++){
        const key=d===3?`${cell[0]+x},${cell[1]+y},${cell[2]+z}`:`${cell[0]+x},${cell[1]+y}`;
        for(const j of cells.get(key)??[]){
          if(this.ring[i] !== this.ring[j]) continue;
          let distance=0;for(let axis=0;axis<d;axis++)distance+=(this.y[i*d+axis]-this.y[j*d+axis])**2;distance=Math.sqrt(distance);
          if(distance<PERSONAL_SPACE) pair(i,j,-12*(PERSONAL_SPACE-distance),distance);
        }
      }
      const key=cell.join(','),bucket=cells.get(key)??[];bucket.push(i);cells.set(key,bucket);
    }
    for(const members of this.owners){
      const center=Array.from({length:d},(_,axis)=>members.reduce((sum,i)=>sum+this.y[i*d+axis]/members.length,0));
      const radius=Math.max(140,d===2?55*Math.sqrt(members.length):70*Math.cbrt(members.length));
      const pulls=members.map(i=>{
        const vector=center.map((value,axis)=>value-this.y[i*d+axis]),distance=Math.hypot(...vector);
        const amount=engaged[i]>.08?0:Math.min(2,Math.max(0,distance-radius-8)*.05);
        return vector.map(value=>distance?value/distance*amount:0);
      });
      const idle=members.every(i=>engaged[i]<=.08);
      for(let axis=0;axis<d;axis++){
        const mean=idle?pulls.reduce((sum,v)=>sum+v[axis]/members.length,0):0;
        members.forEach((i,k)=>{force[i*d+axis]+=pulls[k][axis]-mean;});
      }
    }
    for(const [i,target] of this.ringTargets(dt))for(let axis=0;axis<d;axis++)force[i*d+axis]+=(target[axis]-this.y[i*d+axis])*1.5;
    for(let i=0;i<n;i++){
      for(let axis=0;axis<d;axis++){
        if(this.ring[i]) break;
        const pos=this.y[i*d+axis],excess=Math.max(0,Math.abs(pos)-(this.bounds[axis]-80));
        force[i*d+axis]-=Math.sign(pos)*Math.min(30,excess*.4);
      }
      const acceleration=Math.hypot(...force.subarray(i*d,i*d+d)),cap=Math.max(1,acceleration/MAX_ACCELERATION);
      // Hysteresis keeps imperceptible residual forces from flickering a resting
      // avatar. A real new partner or nearby approaching avatar wakes it gently.
      if(this.sleeping[i] && acceleration<2) continue;
      this.sleeping[i]=0;
      for(let axis=0;axis<d;axis++)this.velocity[i*d+axis]=(this.velocity[i*d+axis]+force[i*d+axis]/cap*dt)*Math.exp(-DRAG*dt);
      const speed=Math.hypot(...this.velocity.subarray(i*d,i*d+d)),speedCap=Math.max(1,speed/MAX_SPEED);
      this.quiet[i]=speed<.12 && acceleration<.5?this.quiet[i]+dt:0;
      if(this.quiet[i]>.8){this.sleeping[i]=1;this.velocity.fill(0,i*d,i*d+d);continue;}
      for(let axis=0;axis<d;axis++){this.velocity[i*d+axis]/=speedCap;this.y[i*d+axis]+=this.velocity[i*d+axis]*dt;}
    }
  }
}
