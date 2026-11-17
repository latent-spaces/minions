/** Presentation projection. Physics and connection identities stay in
 * their original world; only the displayed geometry fits the available pane. */
export function normalizeToViewport(points:Float64Array,width:number,height:number,topInset=0){
 const out=points.slice();if(!points.length||width<=0||height<=0)return out;
 let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
 for(let i=0;i<points.length;i+=3){minX=Math.min(minX,points[i]);maxX=Math.max(maxX,points[i]);minY=Math.min(minY,points[i+1]);maxY=Math.max(maxY,points[i+1]);}
 // Fixed-size portraits, state bubbles and optional names need screen-space
 // gutters. The remaining rectangle can use the phone's full vertical extent.
 const side=Math.min(64,width*.22),top=Math.min(height*.3,Math.max(0,topInset)+54),bottom=Math.min(76,height*.25);
 const usableX=Math.max(1,width-side*2),usableY=Math.max(1,height-top-bottom);
 for(let i=0;i<out.length;i+=3){
  out[i]=(maxX-minX>1?(points[i]-minX)/(maxX-minX):.5)*usableX+side-width/2;
  out[i+1]=(maxY-minY>1?(points[i+1]-minY)/(maxY-minY):.5)*usableY+top-height/2;
 }
 return out;
}
