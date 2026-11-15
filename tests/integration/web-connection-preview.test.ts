import {test,expect} from 'vitest';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {dirname,join} from 'node:path';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
const web=createRequire(new URL('../../apps/web/package.json',import.meta.url));
const root=fileURLToPath(new URL('../../',import.meta.url));

test('older pipes show a bounded latest-message preview with a usable conversation link',async()=>{
 const {createServer}=web('vite'),{chromium}=web('playwright');
 const {default:react}=await import(pathToFileURL(web.resolve('@vitejs/plugin-react')).href);
 const server=await createServer({configFile:false,root:join(root,'tools/communication-lab'),publicDir:false,plugins:[react()],
  resolve:{alias:Object.fromEntries(['react','react-dom'].map(name=>[name,dirname(web.resolve(name+'/package.json'))]))},
  server:{host:'127.0.0.1',port:0,fs:{allow:[root]}}});
 const output=await mkdtemp(join(tmpdir(),'minions-connection-preview-'));let browser:any;
 try{
  await server.listen();browser=await chromium.launch({headless:true,...(process.env.MINIONS_TEST_BROWSER_EXECUTABLE?{executablePath:process.env.MINIONS_TEST_BROWSER_EXECUTABLE}:{})});
  const page=await browser.newPage({viewport:{width:1280,height:1000}});const errors:string[]=[];
  page.on('pageerror',(error:Error)=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as {port:number}).port}/`);
  expect(await page.getByLabel('New sample messages').isChecked()).toBe(false);
  const edge=page.getByRole('button',{name:'Show messages from You to Builder',exact:true});
  await edge.waitFor();
  const hover=async()=>{
   const point=await edge.locator('path').evaluate((path:SVGPathElement)=>{
    const p=path.getPointAtLength(path.getTotalLength()/2).matrixTransform(path.getScreenCTM()!);return {x:p.x,y:p.y};
   });await page.mouse.move(point.x,point.y);
  };
  await hover();const popup=page.getByRole('dialog',{name:'You → Builder',exact:true});await popup.waitFor();
  await popup.getByText('Latest message',{exact:true}).waitFor();
  await page.waitForFunction(()=>document.querySelector('.k42-connection-excerpt')?.textContent?.endsWith('…'));
  const excerpt=await popup.locator('.k42-connection-excerpt').textContent();expect(Array.from(excerpt!).length).toBeLessThanOrEqual(161);
  const link=popup.getByRole('link',{name:'Open conversation →'});
  expect(await link.getAttribute('href')).toBe('#conversation-demo-0');
  await edge.focus();await page.mouse.move(20,20);await page.waitForTimeout(250);expect(await popup.isVisible()).toBe(true);
  await link.hover();await page.waitForTimeout(250);expect(await popup.isVisible()).toBe(true);
  await page.screenshot({path:join(output,'preview-desktop.png')});
  await link.click();await page.getByRole('status').filter({hasText:'Synthetic conversation demo-0 opened'}).waitFor();
  await page.keyboard.press('Escape');expect(await popup.count()).toBe(0);
  await page.getByRole('button',{name:'Send sample message',exact:true}).click();
  await hover();await popup.waitFor();expect(await popup.getByRole('link').getAttribute('href')).toBe('#conversation-demo-3');
  await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'Show messages from You to Builder',exact:true}).scrollIntoViewIfNeeded();
  await hover();await popup.waitFor();
  const box=await popup.boundingBox();expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(390);
  await page.screenshot({path:join(output,'preview-mobile.png')});
  expect(errors).toEqual([]);console.info('Connection preview screenshots:',output);
 }finally{await browser?.close();await server.close();}
},45_000);
