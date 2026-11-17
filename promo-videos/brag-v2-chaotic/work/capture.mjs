import {chromium} from 'playwright';
import {mkdirSync} from 'node:fs';
// node capture.mjs <outdir> <all|t1,t2,...> [end]
const [out,which,endArg]=process.argv.slice(2);mkdirSync(out,{recursive:true});
const FPS=30,END=Number(endArg??20),total=Math.round(END*FPS);
const want=which==='all'?null:new Set(which.split(',').map(s=>Math.round(Number(s)*FPS)));
const SQ=process.env.FMT==='square';const b=await chromium.launch();const pg=await b.newPage({viewport:SQ?{width:1080,height:1080}:{width:1920,height:1080}});
pg.on('pageerror',e=>console.error('pageerror',e.message));
await pg.clock.install({time:new Date('2026-11-16T12:00:00Z')});
await pg.clock.pauseAt(new Date('2026-11-16T12:00:01Z'));
await pg.goto('http://127.0.0.1:47313/'+(SQ?'?fmt=square':''));
for(let i=0;i<100;i++){await pg.clock.runFor(16);await pg.waitForTimeout(50);if(await pg.evaluate(()=>document.fonts.status==='loaded'&&[...document.images].every(i=>i.complete)))break;}
await pg.waitForTimeout(1500);
// start time: the page's t0 is taken on its first rAF
await pg.evaluate(()=>window.__reset=true);await pg.clock.runFor(17);await pg.waitForTimeout(50);
for(let f=0;f<total;f++){
  await pg.evaluate(v=>{window.__T=v;},f/FPS);await pg.clock.runFor(f>0?1000/FPS:17);
  await pg.waitForTimeout(want&&!want.has(f)?6:25);
  if(!want||want.has(f)){    const t=await pg.evaluate(()=>window.__t);
    await pg.screenshot({path:`${out}/f${String(f).padStart(4,'0')}.png`});
    if(want)console.log('frame',f,'t',t.toFixed(3));}
}
await b.close();
