/** A locally swelling tube. Map connections stay straight; illustrations can add a bend. */
export type TubeShape='soft'|'round'|'rubber';
const shapes={
 soft:{radius:1.6,swell:4.2,spread:9,fill:'#f4eff7',ink:1,bead:1.9},
 round:{radius:2.2,swell:5,spread:9,fill:'#eee6f5',ink:1.1,bead:2.5},
 // Thinner lines between agents (owner, 16 November 2026).
 rubber:{radius:.6,swell:1.8,spread:11,fill:'#352b3d',ink:.5,bead:1.2},
};
export function drawTubeConnector(context:CanvasRenderingContext2D,sx:number,sy:number,tx:number,ty:number,phases:number[],color:string,shape:TubeShape='soft',bend=0){
 const dx=tx-sx,dy=ty-sy,length=Math.hypot(dx,dy);if(length<1)return;
 const art=shapes[shape];
 const center=(x:number)=>4*bend*(x/length)*(1-x/length);
 const radius=(x:number)=>{
  const end=Math.max(0,Math.min(1,x/12,(length-x)/12));
  let swell=0;
  for(const phase of phases){const distance=(x-phase*length)/art.spread;const pulse=Math.abs(distance)<1?(1+Math.cos(Math.PI*distance))/2:0;swell=Math.max(swell,art.swell*pulse*end);}
  return art.radius+swell;
 };
 context.save();context.translate(sx,sy);context.rotate(Math.atan2(dy,dx));
 context.strokeStyle=color;context.fillStyle=art.fill;context.lineWidth=art.ink;context.lineJoin='round';context.lineCap='round';
 context.beginPath();context.moveTo(0,-art.radius);
 const steps=Math.max(12,Math.ceil(length/1.5));
 for(let i=1;i<=steps;i++){const x=length*i/steps;context.lineTo(x,center(x)-radius(x));}
 context.arc(length,0,art.radius,-Math.PI/2,Math.PI/2);
 for(let i=steps-1;i>=0;i--){const x=length*i/steps;context.lineTo(x,center(x)+radius(x));}
 context.arc(0,0,art.radius,Math.PI/2,Math.PI*1.5);context.closePath();context.fill();context.stroke();
 // A restrained inner glint gives the flat tube a soft rubbery character.
 context.save();context.globalAlpha*=shape==='rubber'?.08:.55;context.strokeStyle='#fff';context.lineWidth=.8;
 context.beginPath();for(let i=0;i<=steps;i++){const x=length*i/steps,y=center(x)-radius(x)+art.radius*.65;if(i===0)context.moveTo(x,y);else context.lineTo(x,y);}context.stroke();context.restore();
 context.fillStyle='#ce975e';
 for(const phase of phases){context.beginPath();context.arc(phase*length,center(phase*length),art.bead,0,Math.PI*2);context.fill();}
 context.restore();
}
