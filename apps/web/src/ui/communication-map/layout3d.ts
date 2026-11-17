import {SEPARATION,type Traffic} from './layout';
import {pca} from './pca';
/** Genuine 3-D collision projection; the camera never writes into simulation coordinates. */
export function separate3D(y:Float64Array,passes=12){
 const gap=SEPARATION+2;
 for(let pass=0;pass<passes;pass++){
  let hits=0;const cells=new Map<string,number[]>();
  for(let i=0;i<y.length/3;i++){
   const cell=[0,1,2].map(d=>Math.floor(y[i*3+d]/gap));
   for(let x=cell[0]-1;x<=cell[0]+1;x++)for(let v=cell[1]-1;v<=cell[1]+1;v++)for(let z=cell[2]-1;z<=cell[2]+1;z++)for(const j of cells.get(`${x},${v},${z}`)??[]){
    const delta=[0,1,2].map(d=>y[i*3+d]-y[j*3+d]);let norm=Math.hypot(...delta);if(norm>=gap)continue;
    if(norm<1e-9){delta[0]=1;norm=1;}
    for(let d=0;d<3;d++){const step=delta[d]/norm*((gap-norm)/2+.0001);y[i*3+d]+=step;y[j*3+d]-=step;}
    hits++;
   }
   const key=[0,1,2].map(d=>Math.floor(y[i*3+d]/gap)).join(','),bucket=cells.get(key)??[];bucket.push(i);cells.set(key,bucket);
  }
  if(!hits)break;
 }
 return y;
}
export function initialPositions3D(n:number){
 const y=new Float64Array(n*3),side=Math.ceil(Math.cbrt(n));
 for(let i=0;i<n;i++){y[i*3]=(i%side-(side-1)/2)*140;y[i*3+1]=(Math.floor(i/side)%side-(side-1)/2)*140;y[i*3+2]=(Math.floor(i/(side*side))-(side-1)/2)*140;}
 return y;
}
/** Opening-window PCA has three actual principal components, with deterministic
 * jitter only for degenerate zero-variance directions. No future messages are used. */
export function communicationSeed3D(ids:string[],messages:Traffic[]){
 const n=ids.length,index=new Map(ids.map((id,i)=>[id,i])),x=new Float64Array(n*n),degree=new Float64Array(n);
 let start=Infinity;
 for(const m of messages)if(m.audience==='direct'&&index.has(m.agentId)&&m.to.some(id=>id!==m.agentId&&index.has(id)))start=Math.min(start,m.createdAt);
 for(const m of messages){if(m.audience!=='direct'||m.createdAt<start||m.createdAt>start+120000)continue;const a=index.get(m.agentId);if(a===undefined)continue;for(const id of new Set(m.to)){const b=index.get(id);if(b===undefined||a===b)continue;x[a*n+b]++;x[b*n+a]++;degree[a]++;degree[b]++;}}
 if(!degree.some(v=>v>0))return initialPositions3D(n);
 for(let i=0;i<n;i++)if(degree[i]){x[i*n+i]=degree[i];for(let j=0;j<n;j++)x[i*n+j]/=2*degree[i];}
 const {scores,eigenvalues}=pca(x,n,n,3),fallback=initialPositions3D(n);
 let extent=0;for(const value of scores)extent=Math.max(extent,Math.abs(value));
 const scale=Math.max(180,Math.cbrt(n)*70)/Math.max(extent,1e-9);
 for(let i=0;i<n;i++)for(let d=0;d<3;d++)scores[i*3+d]=degree[i]&&eigenvalues[d]>1e-10?scores[i*3+d]*scale:fallback[i*3+d];
 return separate3D(scores,32);
}
