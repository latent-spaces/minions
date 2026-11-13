import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, test } from 'vitest';

let vite:any,chromium:any,origin:string;
beforeAll(async()=>{
  const require=createRequire(new URL('../../apps/web/package.json',import.meta.url));
  const {createServer}=require('vite');({chromium}=require(process.env.MLSWARM_TEST_PLAYWRIGHT??'playwright'));
  const html=`<!doctype html><html><body><main id="root"></main><script type="module">
    import React from 'react';import{createRoot}from'react-dom/client';
    import{AvatarPokeButton}from'/src/ui/AvatarPoke.tsx';
    import'/src/styles.css';
    window.pokes=0;
    function character(el){if(!el)return;el.addEventListener('character-poke',event=>{event.preventDefault();window.pokes++;});}
    createRoot(document.getElementById('root')).render(React.createElement('article',{'data-avatar-poke-scope':'',style:{position:'relative',width:260}},
      React.createElement('a',{href:'#profile',style:{display:'block',padding:20}},
        React.createElement('span',{'data-character-avatar':'','data-poke-available':'true',ref:character,style:{display:'inline-block',width:56,height:56}},'Avatar'),
        React.createElement('span',null,'Worker profile')),
      React.createElement(AvatarPokeButton,{name:'Worker',className:'k42-directory-poke'})));
  </script></body></html>`;
  vite=await createServer({root:fileURLToPath(new URL('../../apps/web',import.meta.url)),configFile:false,
    server:{host:'127.0.0.1',port:0,fs:{allow:[fileURLToPath(new URL('../../',import.meta.url))]}},
    plugins:[{name:'poke-fixture',configureServer(server:any){server.middlewares.use('/__poke.html',(_req:any,res:any)=>{
      void server.transformIndexHtml('/__poke.html',html).then((value:string)=>{res.setHeader('content-type','text/html');res.end(value);});
    });}}]});
  await vite.listen();origin=`http://127.0.0.1:${vite.httpServer.address().port}/__poke.html`;
},30000);
afterAll(async()=>{await vite?.close();});

test('poke is a sibling keyboard button, preserves the profile link and sends no request',async()=>{
  const browser=await chromium.launch({headless:true,...(process.env.MLSWARM_TEST_BROWSER_EXECUTABLE?{executablePath:process.env.MLSWARM_TEST_BROWSER_EXECUTABLE}:{})});
  try{
    const page=await browser.newPage();const commands:string[]=[];
    await page.route('**/api/**',(route:any)=>{commands.push(route.request().url());return route.abort();});
    await page.goto(origin);
    const poke=page.getByRole('button',{name:"Poke Worker's character",exact:true});
    await poke.waitFor();await page.waitForFunction(()=>!document.querySelector('button')!.disabled);
    await poke.hover();
    expect(await poke.evaluate((button:HTMLElement)=>getComputedStyle(button).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
    expect(await poke.evaluate((button:HTMLElement)=>getComputedStyle(button).cursor)).toBe('pointer');
    await page.mouse.down();
    expect(await poke.evaluate((button:HTMLElement)=>getComputedStyle(button).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
    await page.mouse.up();
    await page.waitForFunction(()=>(window as any).pokes===1);
    expect(await page.locator('a button,button button').count()).toBe(0);
    await poke.focus();await page.keyboard.press('Enter');
    await page.waitForFunction(()=>(window as any).pokes===2);
    expect(page.url()).not.toContain('#profile');
    await page.keyboard.press('Space');
    await page.waitForFunction(()=>(window as any).pokes===3);
    await page.evaluate(()=>document.querySelector('[data-character-avatar]')!.setAttribute('data-poke-available','false'));
    await page.waitForFunction(()=>document.querySelector('button')!.disabled);
    await page.getByRole('link',{name:'Avatar Worker profile',exact:true}).click();
    expect(page.url()).toContain('#profile');
    expect(commands).toEqual([]);
  }finally{await browser.close();}
},30000);
