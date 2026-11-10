import { prepareProjectJourney } from '../onboarding/journeys.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { agents, currentProjectId, db, profiles, projectCollection } from '../firestore.js';
import { assertMembership, assertAgentMembership, assertProjectWritable } from './access.js';
import { workerPointer, workerSessions, workerAvailable } from './worker-sessions.js';
import { Refusal } from '../errors.js';
import type { MessageV2 } from '../v2/records.js';

export type SharedSteering = MessageV2 & { kind: 'steering'; actorProfileId: string; actorName: string | null;
  origin: 'coding_chat' | 'local_app'; operationId: string; missionId: string; generation: number;
  state: 'queued' | 'received' | 'included' | 'uncertain' | 'ended'; observedAt: number | null; receiptSequence: number; deliveries?: SteeringRecipient[] };
export type SteeringRecipient = { agentId: string; agentName: string; operationId: string; missionId: string; generation: number;
  state: SharedSteering['state']; observedAt: number | null; receiptSequence: number };
export const steeringRecipients = (m: SharedSteering): SteeringRecipient[] => m.deliveries ?? [m];
export type ConversationEntry = MessageV2 & { kind: 'agent_message' } | SharedSteering;
export const conversationEntries = () => projectCollection<ConversationEntry>('conversationEntries');
const commands = (agent: string, mission: string) => projectCollection<{ entryId: string; state: SharedSteering['state']; createdAt: number }>(`steeringDeliveries/${agent}/runs/${mission}/commands`);
const key = (person: string, id: string) => `steer_${person}_${id}`;
const uuid = z.string().uuid();
export const STEERING_COMMAND = z.object({ operationId: uuid, agentId: z.string().regex(/^[\w-]{1,200}$/), missionId: uuid,
  generation: z.number().int().positive(), body: z.string().min(1).max(16000).refine(s => s.trim().length > 0 && Buffer.byteLength(s) <= 16000 && !s.includes('\0')),
  origin: z.literal('coding_chat') }).strict();
export const STEERING_RECEIPT = z.object({ receiptId: z.string().regex(/^[a-f0-9]{64}$/), operationId: uuid, missionId: uuid,
  generation: z.number().int().positive(), state: z.enum(['received','included','uncertain','ended']),
  sequence: z.number().int().min(1).max(4), observedAt: z.number().int().nonnegative(), turnId: uuid.nullable() }).strict().refine(v => v.sequence === ({received:1,uncertain:2,included:3,ended:4}[v.state]) && v.receiptId === createHash('sha256').update(JSON.stringify(['steering',v.missionId,v.operationId,v.state])).digest('hex') && (['included','uncertain'].includes(v.state) ? v.turnId !== null : v.turnId === null));
const parse = <T>(schema: z.ZodType<T>, value: unknown) => { const p=schema.safeParse(value);if(!p.success)throw new Refusal('bad_input','Use the documented steering fields.');return p.data; };
export async function submitSteering(profileId: string, input: unknown, now: () => number) {
  const batch = z.object({ operationId: uuid, recipients: z.array(STEERING_COMMAND.pick({agentId:true,missionId:true,generation:true,operationId:true})).min(1).max(20), body: STEERING_COMMAND.shape.body, origin: z.literal('coding_chat') }).strict();
  const parsed=parse(z.union([STEERING_COMMAND,batch]),input);
  const targets='recipients' in parsed ? parsed.recipients : [parsed];
  const v={...targets[0],...parsed};
  if(targets[0].operationId!==v.operationId)throw new Refusal('bad_input','The first recipient must use the send operation ID.');
  if(new Set(targets.map(t=>t.agentId)).size!==targets.length || new Set(targets.map(t=>t.operationId)).size!==targets.length)throw new Refusal('bad_input','Name each recipient once.');
  return db.runTransaction(async tx => {
    await assertMembership(tx,profileId);
    const ref=conversationEntries().doc(key(profileId,v.operationId)), saved=(await tx.get(ref)).data();
    if(saved){
      if(saved.kind!=='steering'||saved.body!==v.body||saved.origin!==v.origin||JSON.stringify(steeringRecipients(saved).map(({agentId,missionId,generation,operationId})=>({agentId,missionId,generation,operationId})))!==JSON.stringify(targets.map(({agentId,missionId,generation,operationId})=>({agentId,missionId,generation,operationId}))))throw new Refusal('duplicate','This request already has different steering. Retry the original input.');
      return {created:false,message:saved};
    }
    await assertProjectWritable(tx);
    const author=(await tx.get(profiles.doc(profileId))).data();
    const deliveries:SteeringRecipient[]=[];
    for(const target of targets){
      const agent=(await tx.get(agents().doc(target.agentId))).data();
      if(!agent || agent.ownerProfileId!==profileId)throw new Refusal('forbidden','You can steer only your own agents.');
      await assertAgentMembership(tx,target.agentId);
      const pointer=(await tx.get(workerPointer(target.agentId))).data(), session=(await tx.get(workerSessions(target.agentId).doc(target.missionId))).data();
      const run=(await tx.get(projectCollection<{runId:string;endedAt:number|null}>('runs').doc(target.agentId))).data();
      const queued=await tx.get(commands(target.agentId,target.missionId));
      if(pointer?.missionId!==target.missionId||session?.profileId!==profileId||session?.generation!==target.generation||run?.runId!==session.runId||run?.endedAt!==null||!workerAvailable(session,now()))throw new Refusal('bad_input','This exact agent run is not available for steering. Nothing was sent.');
      if(queued.size>=64||queued.docs.filter(d=>d.data().state==='queued').length>=session.remainingSlots)throw new Refusal('limit_reached','This run cannot accept more steering yet. Nothing was sent.');
      // Per-run command IDs are immutable, including across different group sends.
      if((await tx.get(commands(target.agentId,target.missionId).doc(target.operationId))).exists)throw new Refusal('duplicate','A recipient operation already belongs to another send.');
      deliveries.push({agentId:target.agentId,missionId:target.missionId,generation:target.generation,operationId:target.operationId,agentName:agent.name,state:'queued',observedAt:null,receiptSequence:0});
    }
    const message:SharedSteering={id:ref.id,threadId:ref.id,kind:'steering',...deliveries[0],actorProfileId:profileId,actorName:author?.name??null,
      origin:v.origin,operationId:v.operationId,body:v.body,to:deliveries.map(d=>d.agentId),audience:'direct',createdAt:now(),protocol:2,
      ...('recipients' in parsed ? {deliveries} : {})};
    const progress = await prepareProjectJourney(tx, profileId, currentProjectId(), message.createdAt);
    progress(['firstSteering'], 'steering');
    tx.create(ref,message);for(const d of deliveries)tx.create(commands(d.agentId,d.missionId).doc(d.operationId),{entryId:ref.id,state:'queued',createdAt:message.createdAt});return {created:true,message};
  });
}
export async function steeringResult(profileId:string, operationId:string) { const id=parse(uuid,operationId);return db.runTransaction(async tx=>{await assertMembership(tx,profileId);const message=(await tx.get(conversationEntries().doc(key(profileId,id)))).data();return {message:message?.kind==='steering'?message:null};}); }
export async function pendingSteering(agentId:string, missionId:string, now:()=>number) {
  return db.runTransaction(async tx=>{await assertAgentMembership(tx,agentId);const pointer=(await tx.get(workerPointer(agentId))).data(),session=(await tx.get(workerSessions(agentId).doc(missionId))).data();
    if(pointer?.missionId!==missionId||!workerAvailable(session,now()))return [];
    const rows=await tx.get(commands(agentId,missionId).where('state','==','queued').orderBy('createdAt').orderBy('__name__').limit(64));
    const entries=rows.empty?[]:await tx.getAll(...rows.docs.map(d=>conversationEntries().doc(d.data().entryId)));
    return entries.flatMap(doc=>{const m=doc.data();if(!m||m.kind!=='steering')return [];return steeringRecipients(m).filter(d=>d.agentId===agentId&&d.missionId===missionId&&d.state==='queued').map(d=>({id:d.operationId,body:m.body,missionId:d.missionId,generation:d.generation,threadId:m.threadId}));});
  });
}
export async function observeSteering(agentId:string,input:unknown,now:()=>number) {
  const v=parse(STEERING_RECEIPT,input);
  return db.runTransaction(async tx=>{await assertAgentMembership(tx,agentId);
    const command=(await tx.get(commands(agentId,v.missionId).doc(v.operationId))).data();
    if(!command)throw new Refusal('forbidden','Receipt does not match accepted steering.');
    const ref=conversationEntries().doc(command.entryId), entry=(await tx.get(ref)).data();
    const delivery=entry?.kind==='steering'?steeringRecipients(entry).find(d=>d.agentId===agentId&&d.operationId===v.operationId&&d.missionId===v.missionId&&d.generation===v.generation):undefined;
    if(!entry||entry.kind!=='steering'||!delivery)throw new Refusal('forbidden','Receipt does not match accepted steering.');
    const receipt=projectCollection<{fingerprint:string}>('steeringReceipts').doc(v.receiptId), old=(await tx.get(receipt)).data();
    const fingerprint=createHash('sha256').update(JSON.stringify(v)).digest('hex');if(old){if(old.fingerprint!==fingerprint)throw new Refusal('duplicate','Receipt identity changed.');return {receiptId:v.receiptId};}
    if(v.sequence>delivery.receiptSequence && delivery.state!=='included') {const update={state:delivery.state==='uncertain'&&v.state==='received'?'uncertain' as const:v.state,observedAt:now(),receiptSequence:v.sequence};
      tx.update(ref,entry.deliveries?{...(entry.operationId===v.operationId?update:{}),deliveries:entry.deliveries.map(d=>d.operationId===v.operationId?{...d,...update}:d)}:update);tx.update(commands(agentId,v.missionId).doc(v.operationId),{state:update.state});}
    tx.create(receipt,{fingerprint});return {receiptId:v.receiptId};
  });
}

export async function prepareSteeringEnd(tx: import('../firestore.js').Transaction, agentId: string, missionId: string, at: number) {
  const rows=await tx.get(commands(agentId,missionId));
  const entries=rows.empty?[]:await tx.getAll(...rows.docs.map(d=>conversationEntries().doc(d.data().entryId)));
  return () => {for (const entry of entries) {const m=entry.data();if(m?.kind!=='steering')continue;
    const delivery=steeringRecipients(m).find(d=>d.agentId===agentId&&d.missionId===missionId);
    if(delivery&&['queued','received'].includes(delivery.state)) {
      tx.update(entry.ref,m.deliveries?{...(m.operationId===delivery.operationId?{state:'uncertain',observedAt:at}:{}),deliveries:m.deliveries.map(d=>d===delivery?{...d,state:'uncertain',observedAt:at}:d)}:{state:'uncertain',observedAt:at});
      tx.update(commands(agentId,missionId).doc(delivery.operationId),{state:'uncertain'});
    }
  }};
}
