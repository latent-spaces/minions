import { createHash } from 'node:crypto';
import { RuntimeError, validateCommand, validateTarget } from './contracts.mjs';
// Stable, separate reservation IDs keep the entire send immutable even if its
// first cloud request fails before recording anything. They never queue work.
function derivedId(parts) {
  const hex=createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-8${hex.slice(17,20)}-${hex.slice(20,32)}`;
}
// Coding-chat MCP records through this port before local delivery.
export function createSteering({ accountClient, principal, store }) {
  async function reserveSend(operationId,projectId,recipients,message) {
    const fingerprint=createHash('sha256').update(JSON.stringify([principal.site,principal.ownerId,projectId,recipients,message])).digest('hex');
    await store.reserveSteeringGroup({operationId:derivedId(['steering-send',operationId]),fingerprint});
  }
  return { async submitMany(input) {
    const {operationId,projectId,recipients,message}=input;
    if(new Set(recipients.map(r=>r.agentId)).size!==recipients.length)throw new RuntimeError('bad_input','Name each agent once.');
    const threadId=`steer_${principal.ownerId}_${operationId}`;
    const commands=recipients.map((recipient,index)=>{
      const childId=index===0?operationId:derivedId([operationId,recipient.agentId]);
      return validateCommand({version:2,operationId:childId,kind:'steer',target:{...principal,projectId,agentId:recipient.agentId},missionId:recipient.missionId,generation:recipient.generation,payload:{message,threadId}});
    });
    await reserveSend(operationId,projectId,recipients,message);
    for(const command of commands)await store.reserveSteering(command);
    const targets=commands.map(c=>({agentId:c.target.agentId,missionId:c.missionId,generation:c.generation,operationId:c.operationId}));
    const result=await accountClient.submitSteering(projectId,{operationId,recipients:targets,body:message,origin:'coding_chat'},{expectedProfileId:principal.ownerId});
    const saved=result?.message;
    if(!saved||saved.id!==threadId||saved.threadId!==threadId||saved.operationId!==operationId||saved.actorProfileId!==principal.ownerId||saved.body!==message||saved.origin!=='coding_chat'||JSON.stringify(saved.deliveries?.map(({agentId,missionId,generation,operationId})=>({agentId,missionId,generation,operationId})))!==JSON.stringify(targets))throw new RuntimeError('unconfirmed','Steering acceptance is unconfirmed. Retry the original message.');
    return result;
  }, async submit(command, origin) {
    validateCommand(command);validateTarget(command.target);
    if(command.kind!=='steer'||command.target.ownerId!==principal.ownerId||command.target.site!==principal.site||origin!=='coding_chat')throw new RuntimeError('forbidden','Use your own project steering.');
    await reserveSend(command.operationId,command.target.projectId,[{agentId:command.target.agentId,missionId:command.missionId,generation:command.generation}],command.payload.message);
    await store.reserveSteering(command);
    const result=await accountClient.submitSteering(command.target.projectId,{operationId:command.operationId,agentId:command.target.agentId,missionId:command.missionId,generation:command.generation,body:command.payload.message,origin},{expectedProfileId:principal.ownerId});
    const m=result?.message;if(!m||m.operationId!==command.operationId||m.agentId!==command.target.agentId||m.missionId!==command.missionId||m.generation!==command.generation||m.body!==command.payload.message||m.actorProfileId!==principal.ownerId||m.origin!==origin)throw new RuntimeError('unconfirmed','Steering acceptance is unconfirmed. Retry the original message.');
    return {created:result.created===true,receipt:{operationId:m.operationId,kind:'steer',missionId:m.missionId,generation:m.generation,target:command.target,acceptedAt:m.createdAt},message:m};
  }, async result(input) {const value=await accountClient.steeringResult(input.target.projectId,input.operationId,{expectedProfileId:principal.ownerId});const m=value?.message;if(!m)return null;if(m.operationId!==input.operationId||!(m.deliveries??[m]).some(d=>d.agentId===input.target.agentId&&d.operationId===input.operationId)||m.actorProfileId!==principal.ownerId)throw new RuntimeError('forbidden','Steering belongs to another target.');return {operationId:m.operationId,kind:'steer',missionId:m.missionId,generation:m.generation,target:input.target,acceptedAt:m.createdAt};} };
}
