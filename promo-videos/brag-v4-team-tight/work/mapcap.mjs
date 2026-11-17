import {chromium} from 'playwright';
import {mkdirSync} from 'node:fs';
const out='mapframes';mkdirSync(out,{recursive:true});
const N=Number(process.argv[2]??10), WARM=Number(process.argv[3]??3000);
const b=await chromium.launch();const p=await b.newPage({viewport:{width:1280,height:720},deviceScaleFactor:1.5});
await p.clock.install();
await p.goto('http://127.0.0.1:47311/?embedded=1&device=fullscreen');
await p.waitForSelector('.k42-communication-fullscreen');
await p.click('.k42-communication-fullscreen');
await p.addStyleTag({content:'.lab-measurement{display:none!important}'});
for(let i=0;i<WARM/100;i++){await p.clock.runFor(100);await p.waitForTimeout(15);}
for(let i=0;i<N;i++){await p.clock.runFor(1000/30);await p.waitForTimeout(10);await p.screenshot({path:`${out}/f${String(i).padStart(4,'0')}.png`});}
await b.close();
