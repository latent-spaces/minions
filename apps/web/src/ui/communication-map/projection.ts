/** Orthographic orbit camera. Simulation x/y/z remain unchanged; portraits are
 * screen-space billboards, so fitting a large world never makes them tiny. */
export function projectPoints(points:Float64Array,dimensions:2|3,yaw:number,pitch:number){
 const n=points.length/dimensions,out=new Float64Array(n*3),cy=Math.cos(yaw),sy=Math.sin(yaw),cp=Math.cos(pitch),sp=Math.sin(pitch);
 for(let i=0;i<n;i++){
  const x=points[i*dimensions],y=points[i*dimensions+1],z=dimensions===3?points[i*dimensions+2]:0;
  const rx=dimensions===3?cy*x+sy*z:x,rz=dimensions===3?-sy*x+cy*z:0;
  out[i*3]=rx;out[i*3+1]=dimensions===3?cp*y-sp*rz:y;out[i*3+2]=dimensions===3?sp*y+cp*rz:0;
 }
 return out;
}
/** `closest` bounds how far the fit may zoom in (screen pixels per world unit is height/span). */
export function fitReadableCamera(projected:Float64Array,width:number,height:number,topInset=0,closest=1.2){
 if(!projected.length||width<=0||height<=0)return {x:0,y:0,span:500};
 let left=Infinity,right=-Infinity,top=Infinity,bottom=-Infinity;
 for(let i=0;i<projected.length;i+=3){left=Math.min(left,projected[i]);right=Math.max(right,projected[i]);top=Math.min(top,projected[i+1]);bottom=Math.max(bottom,projected[i+1]);}
 const inset=Math.min(Math.max(0,topInset),height-1),available=Math.max(1,height-inset),margin=80;
 const span=Math.max(height/closest,(bottom-top)*height/Math.max(1,available-2*margin),(right-left)*height/Math.max(1,width-2*margin));
 return {x:(left+right)/2,y:(top+bottom)/2-inset*span/height/2,span};
}
export function screenPoint(projected:Float64Array,index:number,camera:{x:number;y:number;span:number},width:number,height:number){
 const scale=height/camera.span;return {x:width/2+(projected[index*3]-camera.x)*scale,y:height/2+(projected[index*3+1]-camera.y)*scale,z:projected[index*3+2]};
}

/** Keep the overview anchored. Only grow when a portrait approaches the outer
 * gutter, then reserve extra space so ordinary movement cannot pump the zoom. */
export function expandReadableCamera(projected:Float64Array,camera:{x:number;y:number;span:number},width:number,height:number,topInset=0){
 if(width<=0||height<=0)return camera;
 const required=(margin:number)=>{
  const side=Math.max(1,width/2-margin),above=Math.max(1,height/2-topInset-margin),below=Math.max(1,height/2-margin);let span=camera.span;
  for(let i=0;i<projected.length;i+=3){const dx=projected[i]-camera.x,dy=projected[i+1]-camera.y;span=Math.max(span,Math.abs(dx)*height/side,(dy<0?-dy/above:dy/below)*height);}
  return span;
 };
 if(required(64)<=camera.span)return camera;
 return {...camera,span:Math.max(camera.span*1.15,required(96))};
}
