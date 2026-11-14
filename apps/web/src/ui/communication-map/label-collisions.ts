type Rect={left:number;right:number;top:number;bottom:number};
const overlaps=(a:Rect,b:Rect)=>a.left<b.right+6&&a.right>b.left-6&&a.top<b.bottom+4&&a.bottom>b.top-4;
const metrics=new WeakMap<Element,{key:string;box:DOMRect}>();
/** Use the same projected coordinates as portraits and connectors. Cache local
 * text metrics instead of repeatedly forcing browser layout as avatars move. */
export function updateMapLabels(agents:readonly (Element|null)[],points:readonly {x:number;y:number}[],scales:readonly number[]){
 const items=agents.flatMap((agent,i)=>{
  const label=agent?.querySelector<SVGTextElement>('.k42-communication-name');if(!agent||!label||scales[i]<.6)return [];
  const key=label.textContent+':'+document.fonts.status;let metric=metrics.get(label);
  if(metric?.key!==key){metric={key,box:label.getBBox()};metrics.set(label,metric);}
  const scale=scales[i],p=points[i],b=metric.box;
  return [{agent,portrait:{left:p.x-25*scale,right:p.x+25*scale,top:p.y-25*scale,bottom:p.y+25*scale},
   name:{left:p.x+b.x*scale,right:p.x+(b.x+b.width)*scale,top:p.y+b.y*scale,bottom:p.y+(b.y+b.height)*scale},
   inspecting:agent.matches(':hover,:focus-visible,.selected,.is-inspecting')}];
 }).sort((a,b)=>Number(b.inspecting)-Number(a.inspecting));
 const accepted:Rect[]=[];
 for(const item of items){
  const blocked=!item.inspecting&&(items.some(other=>other!==item&&overlaps(item.name,other.portrait))||accepted.some(other=>overlaps(item.name,other)));
  item.agent.classList.toggle('has-label-collision',blocked);
  if(!blocked)accepted.push(item.name);
 }
}
