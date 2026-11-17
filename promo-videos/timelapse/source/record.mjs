// Deterministic capture: fake page clock advances 1/FPS per frame, then a PNG is taken.
import {createRequire} from 'node:module';
import {mkdirSync,rmSync} from 'node:fs';
const {chromium}=createRequire(new URL('../../../package.json',import.meta.url))('playwright');
const [url,out,limit]=[process.argv[2],process.argv[3],Number(process.argv[4]??Infinity)];
const FPS=30,STEP=1000/FPS;
rmSync(out,{recursive:true,force:true});mkdirSync(out,{recursive:true});
const browser=await chromium.launch();
const page=await browser.newPage({viewport:{width:800,height:800},deviceScaleFactor:1.35,colorScheme:'light'});
page.on('pageerror',e=>console.error('pageerror',e.message));
await page.clock.install({time:new Date('2026-11-15T12:00:00Z')});
await page.clock.pauseAt(new Date('2026-11-15T12:00:01Z'));
await page.goto(url);
await page.waitForSelector('.communication-map');
await page.evaluate(()=>document.fonts.ready);
const cdp=await page.context().newCDPSession(page);await cdp.send('Animation.enable');
let rate=1;const total=await page.evaluate(()=>window.__timelapse?.total)??30000;
const frames=Math.min(limit,Math.ceil(total/STEP));const t0=Date.now();
for(let f=0;f<frames;f++){
 const before=Date.now();
 await page.clock.runFor(STEP/2);await page.waitForTimeout(8);await page.clock.runFor(STEP/2);
 await page.screenshot({path:`${out}/f${String(f).padStart(5,'0')}.png`});
 // Keep CSS animations at video speed: real ms spent per frame vs. STEP.
 const spent=Date.now()-before,next=Math.max(.05,Math.min(1,STEP/spent));if(Math.abs(next-rate)>.05){rate=next;await cdp.send('Animation.setPlaybackRate',{playbackRate:rate});}
 if(f%60===0)console.log(`frame ${f}/${frames} ${(spent)}ms/frame`);
}
console.log(`done ${frames} frames in ${((Date.now()-t0)/1000).toFixed(0)}s`);
await browser.close();
