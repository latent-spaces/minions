import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {afterAll,beforeAll,expect,test} from 'vitest';

let vite:any,chromium:any,origin:string;
beforeAll(async()=>{
  const require=createRequire(new URL('../../apps/web/package.json',import.meta.url));
  const {createServer}=require('vite');({chromium}=require(process.env.MLSWARM_TEST_PLAYWRIGHT??'playwright'));
  const html=`<!doctype html><html><body><div id="root"></div><script type="module">
    import React,{useState}from'react';import{createRoot}from'react-dom/client';
    import{AgentAvatar}from'/src/ui/AgentAvatar.tsx';import{PokeAvatar}from'/src/ui/AvatarPoke.tsx';
    import{agentCharacter}from'/src/ui/character-set.ts';import{CharacterPreview}from'/src/ui/character-preview.ts';
    import'/src/styles.css';
    let id;for(let i=0;;i++)if(agentCharacter('hat-review-'+i).id==='cat'){id='hat-review-'+i;break;}
    function Harness(){const[state,setState]=useState('idle');window.hatState=setState;return React.createElement(CharacterPreview.Provider,{value:'gaze'},
      React.createElement('div',{style:{position:'absolute',left:350,top:200}},React.createElement(PokeAvatar,{name:'Hat reviewer'},
        React.createElement(AgentAvatar,{id,name:'Hat reviewer',size:96,persona:'build',state}))));}
    createRoot(document.getElementById('root')).render(React.createElement(Harness));
  </script></body></html>`;
  vite=await createServer({root:fileURLToPath(new URL('../../apps/web',import.meta.url)),configFile:false,
    server:{host:'127.0.0.1',port:0,fs:{allow:[fileURLToPath(new URL('../../',import.meta.url))]}},
    plugins:[{name:'hat-gaze-fixture',configureServer(server:any){server.middlewares.use('/__hat.html',(_req:any,res:any)=>{
      void server.transformIndexHtml('/__hat.html',html).then((value:string)=>{res.setHeader('content-type','text/html');res.end(value);});
    });}}]});
  await vite.listen();origin=`http://127.0.0.1:${vite.httpServer.address().port}/__hat.html`;
},30000);
afterAll(async()=>{await vite?.close();});

test('gaze hat follows its measured direction and resets exactly for poke, work entry and reduced motion',async()=>{
  const browser=await chromium.launch({headless:true,...(process.env.MLSWARM_TEST_BROWSER_EXECUTABLE?{executablePath:process.env.MLSWARM_TEST_BROWSER_EXECUTABLE}:{})});
  try{
    const page=await browser.newPage({viewport:{width:800,height:600},reducedMotion:'no-preference'});
    await page.goto(origin);await page.mouse.move(1,248);
    await page.waitForFunction(()=>document.querySelector('.k42-agent-avatar')?.getAttribute('data-character-gaze-cell')==='3');
    const hat=page.locator('.k42-agent-hat');
    expect(await hat.evaluate((image:HTMLElement)=>getComputedStyle(image).transform)).not.toBe('none');
    await page.getByRole('button',{name:"Poke Hat reviewer's character",exact:true}).click();
    await page.waitForFunction(()=>['poke','rare'].includes(document.querySelector('[data-character-avatar]')?.getAttribute('data-motion')??''));
    expect(await page.locator('.k42-agent-avatar').getAttribute('data-character-gaze-active')).toBeNull();
    expect(await hat.evaluate((image:HTMLElement)=>getComputedStyle(image).transform)).toBe('none');
    await page.waitForFunction(()=>document.querySelector('[data-character-avatar]')?.getAttribute('data-poke-available')==='true');
    await page.mouse.move(1,248);
    await page.waitForFunction(()=>document.querySelector('.k42-agent-avatar')?.getAttribute('data-character-gaze-active')==='true');
    await page.evaluate(()=>(window as any).hatState('working'));
    await page.waitForFunction(()=>document.querySelector('[data-character-avatar]')?.getAttribute('data-motion')==='work-enter');
    expect(await hat.evaluate((image:HTMLElement)=>getComputedStyle(image).transform)).toBe('none');
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.waitForFunction(()=>!document.querySelector('.k42-agent-avatar')?.hasAttribute('data-character-gaze-active'));
    expect(await hat.evaluate((image:HTMLElement)=>getComputedStyle(image).transform)).toBe('none');
    expect(await page.getByRole('button',{name:"Poke Hat reviewer's character",exact:true}).isDisabled()).toBe(true);
  }finally{await browser.close();}
},30000);
