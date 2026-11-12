// Raster regression: crossing tubes cannot leak through overlapping/transparent avatars.
import {test,expect} from 'vitest';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const web=createRequire(new URL('../../apps/web/package.json',import.meta.url));
const root=fileURLToPath(new URL('../../',import.meta.url));
test('connector mask subtracts overlapping avatars at normal and high pixel density',async()=>{
 const {createServer}=web('vite'),{chromium}=web('playwright');
 const html=`<!doctype html><title>Tube occlusion regression</title><body><h1>Tube occlusion</h1><div id="result">Checking…</div><script type="module">
 import {drawTubeConnector} from '/apps/web/src/ui/communication-map/tube-connector.ts';
 import {occludeAvatars} from '/apps/web/src/ui/communication-map/avatar-occlusion.ts';
 const results=[];
 for(const dpr of [1,2]){
  const grid=document.createElement('canvas'),ink=document.createElement('canvas');
  for(const canvas of [grid,ink]){canvas.width=300*dpr;canvas.height=120*dpr;canvas.style.width='300px';canvas.style.height='120px';document.body.append(canvas);}
  const background=grid.getContext('2d'),context=ink.getContext('2d');
  background.scale(dpr,dpr);background.fillStyle='#ddd';background.fillRect(0,59,300,2);
  context.scale(dpr,dpr);context.globalAlpha=.7;
  drawTubeConnector(context,10,60,290,60,[.28],'#887697','rubber');
  occludeAvatars(context,[{x:80,y:60},{x:110,y:60},{x:210,y:60}],[1,1,.3]);
  const alpha=(ctx,x,y)=>ctx.getImageData(Math.round(x*dpr),Math.round(y*dpr),1,1).data[3];
  results.push({dpr,inside:alpha(context,70,60),overlap:alpha(context,95,60),scaled:alpha(context,210,60),outside:alpha(context,170,60),grid:alpha(background,95,60),composite:context.globalCompositeOperation,opacity:context.globalAlpha});
 }
 document.querySelector('#result').textContent=JSON.stringify(results);
 </script>`;
 const server=await createServer({root,configFile:false,server:{host:'127.0.0.1',port:0},plugins:[{name:'occlusion-fixture',configureServer(vite:any){vite.middlewares.use('/__occlusion.html',(_req:any,res:any)=>{void vite.transformIndexHtml('/__occlusion.html',html).then((body:string)=>{res.setHeader('Content-Type','text/html');res.end(body);});});}}]});
 let browser:any;
 try{
  await server.listen();browser=await chromium.launch({headless:true,...(process.env.MLSWARM_TEST_BROWSER_EXECUTABLE?{executablePath:process.env.MLSWARM_TEST_BROWSER_EXECUTABLE}:{})});
  const page=await browser.newPage();const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as {port:number}).port}/__occlusion.html`);
  await page.waitForFunction(()=>document.querySelector('#result')?.textContent?.startsWith('['));
  const results=JSON.parse(await page.locator('#result').textContent());
  for(const result of results){expect(result.inside).toBe(0);expect(result.overlap).toBe(0);expect(result.scaled).toBe(0);expect(result.outside).toBeGreaterThan(0);expect(result.grid).toBe(255);expect(result.composite).toBe('source-over');expect(result.opacity).toBeCloseTo(.7);}
  expect(errors).toEqual([]);
 }finally{await browser?.close();await server.close();}
},30_000);
