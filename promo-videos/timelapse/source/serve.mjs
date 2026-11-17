// Loopback-only Vite server for the synthetic time-lapse page. No API proxy, credentials or model runs.
import {createRequire} from 'node:module';
import {dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const REPO=fileURLToPath(new URL('../../../',import.meta.url)).replace(/\/$/,'');
const web=createRequire(REPO+'/apps/web/package.json');
const {createServer}=await import(pathToFileURL(web.resolve('vite')).href);
const {default:react}=await import(pathToFileURL(web.resolve('@vitejs/plugin-react')).href);
const here=fileURLToPath(new URL('.',import.meta.url));
const server=await createServer({configFile:false,root:here,publicDir:false,logLevel:'warn',plugins:[react()],
 resolve:{alias:{'@repo':REPO,...Object.fromEntries(['react','react-dom','lucide-react'].map(n=>[n,dirname(web.resolve(n+'/package.json'))]))}},
 server:{host:'127.0.0.1',port:Number(process.env.PORT??0),strictPort:true,fs:{strict:true,allow:[REPO,here,dirname(web.resolve('@fontsource-variable/inter/package.json'))]}}});
await server.listen();console.log(`URL http://127.0.0.1:${server.httpServer.address().port}/`);
const close=async()=>{await server.close();process.exit(0);};process.once('SIGINT',close);process.once('SIGTERM',close);
