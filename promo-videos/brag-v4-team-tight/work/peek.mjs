import {chromium} from 'playwright';
const b=await chromium.launch();const p=await b.newPage({viewport:{width:1920,height:1080},deviceScaleFactor:1});
await p.goto('http://127.0.0.1:47311/?embedded=1&device=fullscreen');
await p.waitForTimeout(6000);
await p.screenshot({path:process.argv[2]+'/lab.png'});
await p.click('.k42-communication-fullscreen');await p.waitForTimeout(3000);
await p.screenshot({path:process.argv[2]+'/lab-full.png'});
await b.close();
