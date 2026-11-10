// Synthetic cloud records; no network, credentials or real model. Exercises production shared intake.
import {createRuntimeControllers as controllers} from '../../src/service/controllers.mjs';
import {createSteering} from '../../src/service/steering.mjs';
export function createRuntimeControllers({store,readSyntheticState,...options}) {
  const messages=new Map();let api;
  const cloudFactory=options.cloudFactory;
  const runtime=controllers({...options,store,observeIntervalMs:20,cloudFactory:async mission=>{
    const cloud=cloudFactory?await cloudFactory(mission):{start:async()=>({runId:mission.missionId,cloudGeneration:1}),observe:async()=>readSyntheticState?readSyntheticState(mission):{project:{started:true,paused:false,closed:false},pending:0,acknowledged:0},workerSession:async()=>({missionId:mission.missionId,messages:[]}),phase:async()=>{},reportStatus:async()=>{}};
    return {...cloud,workerSession:async(m,session,args)=>{const reply=await cloud.workerSession(m,session,args);return {...reply,messages:[...reply.messages,...[...messages.values()].filter(v=>v.missionId===m.missionId).map(v=>({id:v.operationId,body:v.body,missionId:v.missionId,generation:v.generation}))]};}};
  }});
  const service=principal=>createSteering({store,principal,accountClient:{async submitSteering(_id,input){const prior=messages.get(input.operationId), saved=await store.getOperation({operationId:input.operationId,target:principal});if(prior&&JSON.stringify(prior)!==JSON.stringify(input))throw Error('Synthetic cloud immutable conflict');messages.set(input.operationId,input);return {created:!prior&&!saved,message:{...input,actorProfileId:principal.ownerId,createdAt:1,state:'queued'}};}}});
  return {...runtime,steering:{async submit(command,origin){const result=await service(command.target).submit(command,origin);const until=Date.now()+3000;while(Date.now()<until){const m=await store.getMission({missionId:command.missionId,target:command.target});if(m.steering.some(v=>v.operationId===command.operationId))return result;await new Promise(r=>setTimeout(r,10));}throw Error('Synthetic recorded steering did not import');}},
    async accept(command){if(command.kind==='steer')return api.steering.submit(command,'coding_chat');return runtime.accept(command);},
    bind(){api=this;return this;}}.bind();
}
