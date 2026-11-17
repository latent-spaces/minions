import {initialPositions,SEPARATION,type Traffic} from './layout.js';
/** Center columns, then the requested leading left singular vectors by matrix-free power
 * iteration on XXᵀ. Scores are U*S, without whitening. No covariance n³ build. */
export function pca(input:Float64Array,n:number,features:number,dimensions=2){
 const x=input.slice(),scores=new Float64Array(n*dimensions),eigenvalues:number[]=[],basis:Float64Array[]=[];
 if(!n||!features)return {scores,eigenvalues:Array(dimensions).fill(0)};
 for(let j=0;j<features;j++){let mean=0;for(let i=0;i<n;i++)mean+=x[i*features+j]/n;for(let i=0;i<n;i++)x[i*features+j]-=mean;}
 const multiply=(v:Float64Array)=>{const temp=new Float64Array(features),out=new Float64Array(n);for(let i=0;i<n;i++)for(let j=0;j<features;j++)temp[j]+=x[i*features+j]*v[i];for(let i=0;i<n;i++)for(let j=0;j<features;j++)out[i]+=x[i*features+j]*temp[j];return out;};
 for(let axis=0;axis<dimensions;axis++){
  let v=Float64Array.from({length:n},(_,i)=>Math.sin((i+1)*(1.3+axis*.7))),lambda=0;
  for(let iteration=0;iteration<64;iteration++){
   const out=multiply(v);for(const previous of basis){let dot=0;for(let i=0;i<n;i++)dot+=out[i]*previous[i];for(let i=0;i<n;i++)out[i]-=dot*previous[i];}
   let norm=0;for(const value of out)norm+=value*value;norm=Math.sqrt(norm);if(norm<1e-12){v.fill(0);break;}
   let delta=0;for(let i=0;i<n;i++){out[i]/=norm;delta+=(out[i]-v[i])**2;}v=out;if(delta<1e-16)break;
  }
  const cv=multiply(v);for(let i=0;i<n;i++)lambda+=v[i]*cv[i];lambda=Math.max(0,lambda);
  let pivot=0;for(let i=1;i<n;i++)if(Math.abs(v[i])>Math.abs(v[pivot]))pivot=i;if(v[pivot]<0)for(let i=0;i<n;i++)v[i]*=-1;
  basis.push(v);eigenvalues.push(lambda);for(let i=0;i<n;i++)scores[dimensions*i+axis]=v[i]*Math.sqrt(lambda);
 }
 return {scores,eigenvalues};
}
/** PCA over an explicitly labeled opening two-minute communication snapshot.
 * This seed summarizes that opening window, not future edge visibility in replay. */
export function communicationSeed(ids:string[],messages:Traffic[]){
 const n=ids.length,index=new Map(ids.map((id,i)=>[id,i])),x=new Float64Array(n*n),degree=new Float64Array(n);let start=Infinity,count=0;
 for(const m of messages)if(m.audience==='direct'&&index.has(m.agentId)&&m.to.some(id=>id!==m.agentId&&index.has(id)))start=Math.min(start,m.createdAt);
 for(const m of messages){if(m.audience!=='direct'||m.createdAt<start||m.createdAt>start+120000)continue;const a=index.get(m.agentId);if(a===undefined)continue;let used=false;
  for(const id of new Set(m.to)){const b=index.get(id);if(b===undefined||b===a)continue;x[a*n+b]++;x[b*n+a]++;degree[a]++;degree[b]++;used=true;}if(used)count++;
 }
 const active=ids.map((_,i)=>i).filter(i=>degree[i]>0),inactive=ids.map((_,i)=>i).filter(i=>!degree[i]);
 if(!active.length)return {points:initialPositions(n),method:'no-history',participants:0,messages:0,start:null,end:null,eigenvalues:[0,0]};
 // A self/neighborhood diffusion profile gives connected pairs similar rows;
 // self mass is a feature only, never an invented communication edge.
 for(const i of active){x[i*n+i]=degree[i];for(let j=0;j<n;j++)x[i*n+j]/=2*degree[i];}
 const {scores,eigenvalues}=pca2(x,n,n),points=new Float64Array(2*n),cells=new Map<string,number[]>(),gap=SEPARATION+8,golden=Math.PI*(3-Math.sqrt(5));
 let extent=0;for(const i of active)extent=Math.max(extent,Math.hypot(scores[2*i],scores[2*i+1]));const scale=extent>1e-12?Math.max(220,Math.sqrt(active.length)*60)/extent:1;
 const place=(i:number,cx:number,cy:number)=>{
  for(let k=0;k<Math.max(256,n*8);k++){
   const radius=gap*.6*Math.sqrt(k),angle=(i+k)*golden,px=cx+radius*Math.cos(angle),py=cy+radius*Math.sin(angle),gx=Math.floor(px/gap),gy=Math.floor(py/gap);let clear=true;
   for(let a=gx-1;a<=gx+1&&clear;a++)for(let b=gy-1;b<=gy+1&&clear;b++)for(const j of cells.get(a+','+b)??[])if(Math.hypot(px-points[2*j],py-points[2*j+1])<gap){clear=false;break;}
   if(!clear)continue;points[2*i]=px;points[2*i+1]=py;const key=gx+','+gy,bucket=cells.get(key)??[];bucket.push(i);cells.set(key,bucket);return;
  }
  throw Error('PCA spacing could not place every agent');
 };
 for(const i of active)place(i,scores[2*i]*scale,scores[2*i+1]*scale);
 let radius=0;for(const i of active)radius=Math.max(radius,Math.hypot(points[2*i],points[2*i+1]));
 for(let k=0;k<inactive.length;k++){const angle=k*golden,r=radius+gap*2+gap*.6*Math.sqrt(k+1);place(inactive[k],r*Math.cos(angle),r*Math.sin(angle));}
 return {points,method:'pca',participants:active.length,messages:count,start,end:start+120000,eigenvalues};
}

export const pca2=(input:Float64Array,n:number,features:number)=>pca(input,n,features,2);
