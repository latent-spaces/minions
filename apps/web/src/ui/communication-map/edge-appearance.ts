/** Presentation easing only: communication weights and simulation remain causal. */
export class EdgeAppearance {
 private edges=new Map<string,{opacity:number;width:number;clock:number}>();
 private lastAt=0;private mode:boolean|null=null;private pruned=0;
 begin(at:number,clock:number,replay:boolean,running:boolean){
  if(this.mode!==replay||replay&&(at<this.lastAt||!running&&at!==this.lastAt))this.edges.clear();
  this.mode=replay;this.lastAt=at;
  if(clock-this.pruned>1000){for(const [key,edge] of this.edges)if(clock-edge.clock>2000)this.edges.delete(key);this.pruned=clock;}
 }
 sample(key:string,opacity:number,width:number,clock:number,instant=false){
  const previous=this.edges.get(key)??{opacity:0,width,clock:clock-16};
  const elapsed=Math.max(0,Math.min(100,clock-previous.clock)),tau=opacity>previous.opacity?240:450,factor=instant?1:1-Math.exp(-elapsed/tau);
  const next={opacity:previous.opacity+(opacity-previous.opacity)*factor,width:previous.width+(width-previous.width)*factor,clock};
  if(opacity===0&&next.opacity<.002)next.opacity=0;
  this.edges.set(key,next);return next;
 }
}
