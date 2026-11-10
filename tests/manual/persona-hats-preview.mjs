import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../apps/web', import.meta.url));
const require = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { createServer } = require('vite');

/** Synthetic artwork inspection using only production avatars and map nodes. No saved personas or agent runs. */
export async function personaHatsPreview(port = 0) {
  const mock = `import{createContext}from'react';export const ProjectScope=createContext('synthetic');export class ApiError extends Error{};export const auth={currentUser:null};export const session={currentUid:()=>undefined};export const read=async()=>({});export const projects=async()=>({});`;
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
  .hat-preview{max-width:1100px;margin:auto;padding:32px 24px}.hat-preview h1{margin:0 0 12px}.hat-preview p{margin-bottom:24px}.hat-preview section{padding:24px 0;border-bottom:1px solid var(--hairline)}.hat-preview h2{font-size:20px;margin:0 0 24px}.hat-preview-grid{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:24px 12px}.hat-preview-cell{display:grid;justify-items:center;gap:12px;font-size:12px;padding-top:16px}.hat-preview select{margin-left:12px}.hat-preview svg{width:100%;max-width:720px;overflow:visible;margin-top:16px}@media(max-width:600px){.hat-preview-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.hat-preview{padding:24px 16px}}
  </style></head><body><main id="root" class="hat-preview"></main><script type="module">
  import React,{useState} from 'react';import{createRoot}from'react-dom/client';
  import{AgentAvatar}from'/src/ui/AgentAvatar.tsx';import{CommunicationAgentNode}from'/src/ui/CommunicationAgentNode.tsx';
  import{ANIMAL_FAMILIES,ownerAppearance}from'/src/ui/animal-family.ts';import'/src/styles.css';import'/src/ui/project-communication.css';
  const owners=new Map();for(let n=0;owners.size<ANIMAL_FAMILIES.length&&n<10000;n++){const id='illustrative-owner-'+n;const{family}=ownerAppearance(id);if(!owners.has(family))owners.set(family,id);}
  const families=['turtle','seal',...ANIMAL_FAMILIES.filter(f=>!['turtle','seal'].includes(f))];
  const hats=[['default','No hat'],['build','Build'],['review','Review'],['updates','Share progress'],['moderator','Community rules'],['custom','Custom']];
  const title=f=>f[0].toUpperCase()+f.slice(1);
  function Preview(){const[chosen,setChosen]=useState('all');return React.createElement(React.Fragment,null,
   React.createElement('h1',null,'Animals with hats'),React.createElement('p',{className:'muted'},'Illustrative preview · synthetic owners · no saved persona changes. Updated face zoom and thin silhouette outline.'),
   React.createElement('label',null,'Animal family',React.createElement('select',{value:chosen,onChange:e=>setChosen(e.target.value)},React.createElement('option',{value:'all'},'All families'),...families.map(f=>React.createElement('option',{value:f,key:f},title(f))))),
   ...families.filter(f=>chosen==='all'||chosen===f).map(f=>React.createElement('section',{key:f,'aria-label':title(f)+' family'},React.createElement('h2',null,title(f)),React.createElement('div',{className:'hat-preview-grid'},...hats.map(([persona,label])=>React.createElement('div',{key:persona,className:'hat-preview-cell'},React.createElement(AgentAvatar,{name:title(f)+' agent',id:'illustrative-agent-'+f,ownerId:owners.get(f),size:76,persona}),React.createElement('span',null,label)))))),
   React.createElement('section',{'aria-label':'Map portraits with hats'},React.createElement('h2',null,'On the map'),React.createElement('svg',{viewBox:'0 0 720 140'},...hats.map(([persona,label],i)=>React.createElement(CommunicationAgentNode,{key:persona,node:{id:'illustrative-agent-turtle',name:label,ownerId:owners.get('turtle'),x:60+i*120,y:42},now:0,selected:false,replay:false,compact:true,agent:{id:'illustrative-agent-turtle',name:label,mine:false,state:'idle',focus:null,reportedAt:null,lastContactAt:null,freshUntil:null,personaChoice:persona},tooltipId:'preview-tip',inspecting:false,onInspect:()=>{},onLeave:()=>{},onDismiss:()=>{},onSelect:()=>{}})))));}
  createRoot(document.getElementById('root')).render(React.createElement(Preview));</script></body></html>`;
  const server = await createServer({ root, configFile: false, server: { host: '127.0.0.1', port, strictPort: true }, plugins: [{ name: 'persona-hats-preview', enforce: 'pre', load(id) { if (id === root + '/src/api.ts') return mock; }, configureServer(vite) { vite.middlewares.use('/__hats.html', (_req, res) => void vite.transformIndexHtml('/__hats.html', html).then(value => { res.setHeader('Content-Type', 'text/html'); res.end(value); })); } }] });
  await server.listen(); return server;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) { const server = await personaHatsPreview(Number(process.argv[2] ?? 5194)); console.log('Preview: http://127.0.0.1:' + server.httpServer.address().port + '/__hats.html'); }
