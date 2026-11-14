// Small read-only frontend lab. No application config, credentials, API proxy or model runs.
import {createRequire} from 'node:module';
import {dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const web=createRequire(new URL('../../apps/web/package.json',import.meta.url));
const {createServer}=await import(pathToFileURL(web.resolve('vite')).href);
const {default:react}=await import(pathToFileURL(web.resolve('@vitejs/plugin-react')).href);
const port=Number(process.env.MLSWARM_LAB_PORT??0);
if(!Number.isInteger(port)||port<0||port>65535)throw Error('Invalid MLSWARM_LAB_PORT');
const server=await createServer({configFile:false,root:fileURLToPath(new URL('.',import.meta.url)),publicDir:false,
 plugins:[react()],resolve:{alias:Object.fromEntries(['react','react-dom','lucide-react'].map(name=>[name,dirname(web.resolve(name+'/package.json'))]))},
 server:{host:'127.0.0.1',port,strictPort:true,fs:{strict:true,allow:[fileURLToPath(new URL('../../',import.meta.url)),dirname(web.resolve('@fontsource-variable/inter/package.json'))]}}});
await server.listen();console.info(`Connector lab: http://127.0.0.1:${server.httpServer.address().port}/\nSynthetic data only; no API proxy, accounts or agent execution.`);
let closing=false;const close=async()=>{if(closing)return;closing=true;await server.close();};
process.once('SIGINT',close);process.once('SIGTERM',close);
