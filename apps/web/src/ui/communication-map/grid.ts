import {projectPoints,screenPoint} from './projection';
type Camera={x:number;y:number;span:number};
/** Grid vertices are fixed world coordinates, never a screen-anchored texture.
 * Change only level of detail with zoom; cap work for large worlds. */
export function worldGrid(camera:Camera,width:number,height:number,dimensions:2|3,yaw:number,pitch:number,floorY=0,radius=1000){
 if(width<=0||height<=0)return [];
 const desired=camera.span/height*90,base=10**Math.floor(Math.log10(Math.max(1,desired))),step=[1,2,5,10].map(v=>v*base).find(v=>v>=desired)??base*10;
 const halfX=camera.span*width/height/2,halfY=camera.span/2;
 const minX=dimensions===2?camera.x-halfX:-radius,maxX=dimensions===2?camera.x+halfX:radius,minY=dimensions===2?camera.y-halfY:-radius,maxY=dimensions===2?camera.y+halfY:radius;
 const boundedStep=Math.max(step,10**Math.ceil(Math.log10(Math.max(maxX-minX,maxY-minY)/80)));
 const lines:{x1:number;y1:number;x2:number;y2:number;major:boolean}[]=[];
 const add=(a:number,b:number,c:number,d:number,major:boolean)=>{
  const vertices=dimensions===2?new Float64Array([a,b,c,d]):new Float64Array([a,floorY,b,c,floorY,d]),projected=projectPoints(vertices,dimensions,yaw,pitch),p=screenPoint(projected,0,camera,width,height),q=screenPoint(projected,1,camera,width,height);
  lines.push({x1:p.x,y1:p.y,x2:q.x,y2:q.y,major});
 };
 for(let x=Math.ceil(minX/boundedStep)*boundedStep;x<=maxX;x+=boundedStep)add(x,minY,x,maxY,Math.round(x/boundedStep)%5===0);
 for(let y=Math.ceil(minY/boundedStep)*boundedStep;y<=maxY;y+=boundedStep)add(minX,y,maxX,y,Math.round(y/boundedStep)%5===0);
 return lines;
}
