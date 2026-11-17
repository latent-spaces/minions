// Copy of tools/communication-lab/start.mjs pointed at this stage; synthetic data only.
import {createRequire} from 'node:module';
import {dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const repo=new URL('../../../../',import.meta.url);
const web=createRequire(new URL('apps/web/package.json',repo));
const {createServer}=await import(pathToFileURL(web.resolve('vite')).href);
const {default:react}=await import(pathToFileURL(web.resolve('@vitejs/plugin-react')).href);
const server=await createServer({configFile:false,root:fileURLToPath(new URL('.',import.meta.url)),publicDir:false,
 plugins:[react()],resolve:{alias:Object.fromEntries(['react','react-dom','lucide-react'].map(n=>[n,dirname(web.resolve(n+'/package.json'))]))},
 server:{host:'127.0.0.1',port:47317,strictPort:true,fs:{strict:true,allow:[fileURLToPath(repo),dirname(web.resolve('@fontsource-variable/inter/package.json'))]}}});
await server.listen();console.info('stage http://127.0.0.1:47317/');
