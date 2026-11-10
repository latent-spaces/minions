import {communicationWeights} from './layout.js';
import {communicationSeed} from './pca.js';
import {communicationSeed3D} from './layout3d';
import {ConversationMotion} from './motion';
import type {MapRequest,MapReply} from './protocol.js';
let engine:ConversationMotion|null=null,traffic:Extract<MapRequest,{kind:'traffic'}>['traffic']=[];
const reply=(data:MapReply)=>self.postMessage(data);
self.onmessage=({data}:{data:MapRequest})=>{
 try{
  if(data.kind==='init'){
   const dimensions=data.dimensions??2,ids=data.nodes.map(n=>n.id);traffic=data.traffic;
   const seed=dimensions===3?communicationSeed3D(ids,traffic):communicationSeed(ids,traffic).points;
   engine=new ConversationMotion(ids,seed,dimensions,data.nodes.map(n=>n.ownerId),data.nodes.map(n=>!!data.peopleRing&&!!n.person));reply({kind:'seed',points:engine.y.slice()});
  }else if(data.kind==='traffic'){
   // First traffic is a relationship change, not permission to teleport the roster.
   traffic=data.traffic;
  }else if(engine){reply({kind:'frame',sequence:data.sequence,points:engine.step(communicationWeights(traffic,data.at),data.elapsedMs/1000).points});}
 }catch(error){reply({kind:'error',message:error instanceof Error?error.message:'Layout failed'});}
};
