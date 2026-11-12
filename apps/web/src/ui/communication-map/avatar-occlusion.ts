/** Remove connector ink under every billboard, including transparent hair/hat margins.
 * Destination-out subtracts the UNION of overlapping footprints, unlike an even-odd clip. */
export function occludeAvatars(context:CanvasRenderingContext2D,points:readonly {x:number;y:number}[],scales:readonly number[]){
 context.save();context.globalCompositeOperation='destination-out';context.globalAlpha=1;context.fillStyle='#000';
 for(const [i,point] of points.entries()){
  const scale=scales[i]??1;
  context.beginPath();context.roundRect(point.x-28*scale,point.y-40*scale,56*scale,68*scale,12*scale);context.fill();
 }
 context.restore();
}
