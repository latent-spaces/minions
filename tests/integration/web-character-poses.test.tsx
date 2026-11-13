import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {afterAll,beforeAll,expect,test} from 'vitest';
let vite:any,chromium:any,origin:string;
beforeAll(async()=>{
  const require=createRequire(new URL('../../apps/web/package.json',import.meta.url));
  const {createServer}=require('vite');({chromium}=require('playwright'));
  const html=`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">
  import React,{useState}from'react';import{createRoot}from'react-dom/client';
  import{CharacterAvatar}from'/src/ui/CharacterAvatar.tsx';import{CharacterPreview}from'/src/ui/character-preview.ts';
  import'/src/styles.css';
  function Harness(){const[state,setState]=useState('idle');window.setReviewState=setState;
    window.pokeReview=reaction=>document.querySelector('[data-character-avatar]').dispatchEvent(new CustomEvent('character-poke',{cancelable:true,detail:{reaction}}));
    window.messageReview=id=>document.querySelector('[data-character-avatar]').dispatchEvent(new CustomEvent('character-message',{detail:{id}}));
    return React.createElement(CharacterPreview.Provider,{value:'gaze'},React.createElement('main',{'data-review-state':state,style:{padding:80}},React.createElement('h1',null,'Synthetic pose handoff test'),React.createElement('span',{'data-character-motion-root':'',style:{display:'block',width:140,height:140}},React.createElement(CharacterAvatar,{character:'cat',animationKey:'handoff-cat',src:'/src/ui/assets/characters/offbeat/poses/cat-neutral.png',state}))));}
  createRoot(document.getElementById('root')).render(React.createElement(Harness));
  </script></body></html>`;
  vite=await createServer({root:fileURLToPath(new URL('../../apps/web',import.meta.url)),configFile:fileURLToPath(new URL('../../apps/web/vite.config.ts',import.meta.url)),
    server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'poses-fixture',configureServer(server:any){server.middlewares.use('/__poses.html',(_req:any,res:any)=>{void server.transformIndexHtml('/__poses.html',html).then((value:string)=>{res.setHeader('content-type','text/html');res.end(value);});});}}]});
  await vite.listen();origin=`http://127.0.0.1:${vite.httpServer.address().port}/__poses.html`;
},30000);
afterAll(async()=>{await vite?.close();});
const browser=()=>chromium.launch({headless:true,...(process.env.MLSWARM_TEST_BROWSER_EXECUTABLE?{executablePath:process.env.MLSWARM_TEST_BROWSER_EXECUTABLE}:{})});

test('decoded pose banks survive fifty mixed handoffs without a blank or double head',async()=>{
  const b=await browser();
  try{
    const p=await b.newPage({viewport:{width:1000,height:800},reducedMotion:'no-preference'}),errors:string[]=[];
    p.on('pageerror',(error:Error)=>errors.push(error.message));
    await p.addInitScript(()=>{
      const w=window as any;w.poseTime=0;
      const native=performance.now.bind(performance),raf=requestAnimationFrame.bind(window);
      performance.now=()=>native()+w.poseTime;window.requestAnimationFrame=callback=>raf(time=>callback(time+w.poseTime));
    });
    await p.goto(origin);await p.waitForFunction(()=>document.querySelector('[data-character-avatar]')?.getAttribute('data-poke-available')==='true');
    await p.mouse.move(900,300);
    const assertFace=async()=>{
      const result=await p.locator('[data-character-avatar]').evaluate((avatar:HTMLElement)=>{
        const visible=[...avatar.querySelectorAll<HTMLElement>('[data-pose-layer]')].filter(layer=>getComputedStyle(layer).visibility==='visible');
        const neutral=avatar.querySelector<HTMLImageElement>('.k42-character-neutral')!;
        if(!visible.length)return {count:0,valid:getComputedStyle(neutral).visibility==='visible'&&neutral.complete&&neutral.naturalWidth>0};
        const image=visible[0].querySelector<HTMLImageElement>('img')!,cell=Number(avatar.dataset.frame);
        const canvas=document.createElement('canvas');canvas.width=320;canvas.height=320;
        const context=canvas.getContext('2d')!;context.drawImage(image,cell%3*320,Math.floor(cell/3)*320,320,320,0,0,320,320);
        const pixels=context.getImageData(0,0,256,256).data;let opaque=0;for(let i=3;i<pixels.length;i+=4)if(pixels[i]>128)opaque++;
        return {count:visible.length,valid:getComputedStyle(neutral).visibility==='hidden'&&image.complete&&image.naturalWidth===960&&opaque>1000};
      });
      expect(result.count).toBeLessThanOrEqual(1);expect(result.valid).toBe(true);
    };
    for(let i=0;i<50;i++){
      const action=i%8,state=action===2?'working':action===3?'stopped':action===4?'needs_you':action===5?'blocked':'idle';
      await p.evaluate(state=>(window as any).setReviewState(state),state);
      await p.waitForFunction(state=>document.querySelector('main')?.getAttribute('data-review-state')===state,state);
      await p.evaluate(()=>{(window as any).poseTime+=700;});await p.waitForTimeout(70);
      if(action===1||action===7){
        await p.waitForFunction(()=>document.querySelector('[data-character-avatar]')?.getAttribute('data-poke-available')==='true');
        expect(await p.evaluate(reaction=>(window as any).pokeReview(reaction),action===7?'rare':'smile')).toBe(false);
        await p.evaluate(()=>{(window as any).poseTime+=320;});await p.waitForTimeout(70);
      }else if(action===6){await p.evaluate(id=>(window as any).messageReview(id),`handoff-${i}`);await p.evaluate(()=>{(window as any).poseTime+=320;});await p.waitForTimeout(70);}
      await assertFace();
    }
    await p.emulateMedia({reducedMotion:'reduce'});await p.waitForTimeout(80);await assertFace();
    expect(await p.locator('[data-character-avatar]').getAttribute('data-poke-available')).toBe('false');
    expect(errors).toEqual([]);
  }finally{await b.close();}
},30000);

test('failed incoming atlases retain a visible neutral and reject pokes',async()=>{
  const b=await browser();
  try{
    const p=await b.newPage({viewport:{width:390,height:844}});
    await p.route('**/poses/*.webp*',(route:any)=>route.request().resourceType()==='image'?route.abort():route.continue());await p.goto(origin);
    await p.waitForFunction(()=>{const image=document.querySelector<HTMLImageElement>('.k42-character-neutral');return image?.complete&&image.naturalWidth===192;});
    await p.waitForTimeout(200);
    const avatar=p.locator('[data-character-avatar]');expect(await avatar.getAttribute('data-poke-available')).toBe('false');
    expect(await avatar.locator('.k42-character-neutral').evaluate((image:HTMLImageElement)=>getComputedStyle(image).visibility)).toBe('visible');
    expect(await avatar.locator('[data-pose-layer]').evaluateAll((layers:HTMLElement[])=>layers.every(layer=>getComputedStyle(layer).visibility==='hidden'))).toBe(true);
    expect(await p.evaluate(()=>(window as any).pokeReview('rare'))).toBe(true);
  }finally{await b.close();}
},30000);
