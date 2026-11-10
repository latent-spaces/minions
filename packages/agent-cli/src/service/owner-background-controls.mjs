// Background facet of the existing approved-computer delivery pump. This owns
// transport only: control_agent and SQLite remain the sole command writer.
import { RuntimeError, commandFingerprint, sameTarget, validateCommand, validateUuid } from './contracts.mjs';
import { createConfirmedSnapshots } from './owner-snapshot-refresh.mjs';

const terminalCodes=new Set(['invalid_command','forbidden','conflict','invalid_binding','stale_generation','not_found','unauthorized','run_superseded','runtime_conflict']);
const failure={state:'failed',message:'This control could not be applied. Inspect the current background mission before approving another action.'};
const terminalStates=new Set(['stopping','stopped','failed','recovery_required']);
export function createOwnerBackgroundControls({store,controllers,ownerClient,owner,targets,call,refreshMs=40000,now=Date.now}) {
  if(typeof store?.latestBackgroundsForTargets!=='function' || typeof controllers?.accept!=='function' || typeof controllers?.getMission!=='function'
    || ['syncBackgrounds','listBackgroundControls','acknowledgeBackgroundControl'].some(name=>typeof ownerClient?.[name]!=='function'))
    throw new TypeError('Background delivery requires trusted controller, snapshot and approved-computer ports.');
  const pending=new Map();let closed=false;
  const confirmed=createConfirmedSnapshots({refreshMs,now});
  const options=signal=>({signal,expectedProfileId:owner.ownerId});
  async function publish(chosen,required) {
    // Only the periodic full sync may skip confirmed pages; receipt proof always sends.
    const periodic=chosen===undefined,selected=chosen??targets();
    if(periodic)confirmed.retain(selected);
    let failed;
    for(let offset=0;offset<Math.max(selected.length,1);offset+=32)try {
      const batch=selected.slice(offset,offset+32),rows=await call(()=>store.latestBackgroundsForTargets({targets:batch}));
      if(!Array.isArray(rows)||rows.length>batch.length||rows.some(row=>!batch.some(target=>sameTarget(target,row?.target))))
        throw new RuntimeError('invalid_snapshot','Background snapshots are unavailable.');
      // Never publish scope, native PIDs, paths, model output or local credentials.
      const backgrounds=rows.map(({target,missionId,generation,state,pauseOperationId,cloudRun,updatedAt})=>({
        target:structuredClone(target),missionId,generation,state,pauseOperationId:pauseOperationId??null,
        cloudRun:cloudRun?{runId:cloudRun.runId,generation:cloudRun.generation}:null,updatedAt}));
      if(required&&!backgrounds.some(row=>row.missionId===required.missionId&&row.generation===required.generation))
        throw new RuntimeError('invalid_snapshot','The exact background mission snapshot is unavailable.');
      if(!backgrounds.length)continue; // Saved bindings without missions have nothing to publish.
      if(periodic&&confirmed.fresh(backgrounds))continue;
      const sentAt=now(),ack=await call(signal=>ownerClient.syncBackgrounds({backgrounds},options(signal)));
      if(ack?.ok!==true)throw new RuntimeError('invalid_receipt','Background snapshot was not confirmed.');
      confirmed.confirm(backgrounds,sentAt);
    }catch(error){failed??=error;}
    if(failed)throw failed;
  }
  async function acknowledge(item,receipt) {
    const ack=await call(signal=>ownerClient.acknowledgeBackgroundControl(item.id,receipt,options(signal)));
    if(ack?.ok!==true)throw new RuntimeError('invalid_receipt','Background control receipt was not confirmed.');
  }
  function dispatch(envelope) {
    let command,fingerprint;
    try {
      validateUuid(envelope?.id,'controlId');command=structuredClone(validateCommand(envelope.command));
      if(command.operationId!==envelope.id||!['pause','resume','stop'].includes(command.kind)
        ||!Number.isSafeInteger(envelope.deadlineAt)||envelope.deadlineAt<1||!targets().some(target=>sameTarget(target,command.target)))
        throw new RuntimeError('forbidden','Background target does not belong to this installation.');
      fingerprint=commandFingerprint(command);
    }catch {
      try{validateUuid(envelope?.id,'controlId');}catch{return;}
      if(!pending.has(envelope.id)&&pending.size<32)pending.set(envelope.id,{id:envelope.id,receipt:failure});return;
    }
    const known=pending.get(envelope.id);
    if(known){if(known.fingerprint!==fingerprint)known.receipt??=failure;return;}
    if(pending.size>=32)return;
    const item={id:envelope.id,command,fingerprint,deadlineAt:envelope.deadlineAt};pending.set(item.id,item);
    item.task=(async()=>{
      if(Date.now()>=item.deadlineAt){item.receipt={state:'expired'};return;}
      // accept() latches Pause before serialized persistence; it never waits for
      // the active native turn to finish. Exact retries use the saved SQL receipt.
      const accepted=await call(()=>controllers.accept(command));
      if(accepted?.receipt?.operationId!==item.id||accepted.receipt.fingerprint!==fingerprint)
        throw new RuntimeError('invalid_reply','Background command acceptance was not confirmed.');
      item.accepted=true;
    })().catch(error=>{if(terminalCodes.has(error?.code))item.receipt=failure;})
      .finally(()=>{item.task=null;});
  }
  async function refresh(item) {
    if(item.task)return;
    // Resume proof is meaningful only after the cloud records this exact durable
    // acceptance, never from an unrelated unpaused snapshot.
    if(item.accepted&&!item.acceptedAcknowledged){await acknowledge(item,{state:'accepted'});item.acceptedAcknowledged=true;}
    if(!item.receipt&&item.accepted) {
      const mission=await call(()=>controllers.getMission({missionId:item.command.missionId,target:item.command.target}));
      if(!mission||mission.generation!==item.command.generation||!sameTarget(mission.target,item.command.target))item.receipt=failure;
      else if(item.command.kind==='stop') {
        const last=mission.outcomes?.at(-1)?.outcome;
        if(mission.state==='stopped'&&mission.guardPid===null&&mission.currentTurnId===null
          &&(!last||last.cleanupConfirmed===true&&last.delivery!=='submitted'))item.receipt={state:'applied'};
        else if(mission.state==='failed'||mission.state==='recovery_required'&&mission.reason!=='mission_cleanup_pending')item.receipt=failure;
        else if(Date.now()>=item.deadlineAt)item.receipt={state:'expired'};
      }
      else if(Date.now()>=item.deadlineAt)item.receipt={state:'expired'};
      else if(terminalStates.has(mission.state))item.receipt=failure;
      else if(item.command.kind==='pause') {
        const last=mission.outcomes?.at(-1)?.outcome;
        if(mission.state==='paused'&&mission.pauseOperationId===item.id&&mission.guardPid===null&&mission.currentTurnId===null
          &&(!last||last.cleanupConfirmed===true&&last.delivery!=='submitted'))item.receipt={state:'applied'};
        else if(mission.pauseOperationId!==item.id)item.receipt=failure;
      }else if(!mission.pauseOperationId&&!['pausing','paused'].includes(mission.state))item.receipt={state:'applied'};
      else item.receipt=failure;
    }
    if(item.receipt) {
      if(item.receipt.state==='applied')await publish([item.command.target],item.command);
      else if(item.command)await publish([item.command.target]).catch(()=>{});
      await acknowledge(item,item.receipt);pending.delete(item.id);
    }else if(!item.accepted)pending.delete(item.id); // transient failure: fetch/retry the same immutable command
  }
  return {async poll(){
    if(closed)return;
    await publish().catch(()=>{});
    const value=await call(signal=>ownerClient.listBackgroundControls(options(signal)));
    if(!value||!Array.isArray(value.commands)||value.commands.length>32||!Number.isSafeInteger(value.serverTime))
      throw new RuntimeError('invalid_reply','Background control mailbox returned invalid data.');
    const ids=new Set(value.commands.map(item=>item?.id));
    for(const [id,item]of pending)if(!item.task&&!ids.has(id))pending.delete(id);
    for(const envelope of value.commands)dispatch(envelope);
    await Promise.allSettled([...pending.values()].map(item=>item.task));
    // Snapshot writes are serial, including proof before an applied receipt.
    for(const item of pending.values())try{await refresh(item);}catch{/* Retain exact evidence/receipt for the next owner-pump tick. */}
  },async close(){closed=true;await Promise.allSettled([...pending.values()].map(item=>item.task));}};
}
