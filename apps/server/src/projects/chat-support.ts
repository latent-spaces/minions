// Durable chat interactions. Human reads never enqueue or acknowledge agent work.
import { FieldPath, FieldValue, type Timestamp, type Transaction } from '../firestore.js';
import { z } from 'zod';
import { hashToken } from '../auth.js';
import { collection, db, inProject, profiles, type Profile, type WithId } from '../firestore.js';
import { conversationEntries } from './steering.js';
import { assertMembership } from './access.js';
import { assertChatWrite, chatReadAccess, humanMessages, type HumanMessage } from './chat-records.js';
import { Refusal } from '../errors.js';
import { publicProfilePhoto } from '../community/profile-photo-ref.js';
import { decodeCursor, encodeCursor } from '../cursor.js';

const ID = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const HUMAN_ID = z.string().regex(/^[a-f0-9]{64}$/);
export const REACTION = z.object({ emoji: z.enum(['👍','❤️','🎉','👀']), active: z.boolean() }).strict();
const POINTER = z.object({ createdAt: z.number().int().nonnegative(), id: ID }).strict();
export const READ_CHAT = z.object({ channel: z.enum(['human','agent']), threadId: ID.optional(), through: POINTER }).strict().superRefine((v,c) => {
  if ((v.channel === 'agent') !== !!v.threadId) c.addIssue({ code:'custom', message:'Agent reads require a thread; human reads do not.', path:['threadId'] });
});
type Channel = 'human'|'agent';
type Pointer = z.infer<typeof POINTER>;
type ReactionCounts = Record<string, number>;
const reactions = (id:string) => collection<{ counts: ReactionCounts; updatedAt?: Timestamp }>(`projects/${id}/chatReactions`);
const actor = (id:string, channel:Channel, message:string, person:string) => collection<{ emojis: string[] }>(`projects/${id}/chatReactions/${channel}-${message}/actors`).doc(hashToken(person));
const readStates = (id:string) => collection<{ through: Pointer }>(`projects/${id}/chatReadStates`);
const stateRef = (id:string, person:string, channel:Channel, thread?:string) => readStates(id).doc(hashToken(JSON.stringify([person,channel,thread??null])));
const compare = (a:Pointer,b:Pointer) => a.createdAt-b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const parse = <T>(schema:z.ZodType<T>,value:unknown):T => {const found=schema.safeParse(value);if(!found.success)throw new Refusal('bad_input','Some fields in this request are missing or not in the expected form.');return found.data;};
async function reactionRows(tx:Transaction,id:string,channel:Channel,ids:string[],personId?:string) {
  if(!ids.length)return [];
  const summary=await tx.getAll(...ids.map(key=>reactions(id).doc(`${channel}-${key}`)));
  const own=personId?await tx.getAll(...ids.map(key=>actor(id,channel,key,personId))):[];
  return ids.map((key,index)=>({id:key,reactions:['👍','❤️','🎉','👀'].flatMap(emoji=>{
    const count=summary[index].data()?.counts[emoji]??0;
    return count>0?[{emoji,count,reacted:own[index]?.data()?.emojis.includes(emoji)??false}]:[];
  })}));
}
export async function decorateHumanChat(tx:Transaction,id:string,operator:WithId<Profile>|null,rows:{id:string;message:HumanMessage}[]) {
  const decorated=await reactionRows(tx,id,'human',rows.map(r=>r.id),operator?.id);
  // Current consent follows immutable people, including quoted senders. It is
  // never copied into historical message/reply documents or joined by name.
  const ids=[...new Set(rows.flatMap(row=>[row.message.sender.id,...(row.message.reply?[row.message.reply.sender.id]:[])]))].filter(value=>ID.safeParse(value).success);
  const people=ids.length?await tx.getAll(...ids.map(person=>profiles.doc(person))):[];
  const photos=new Map(people.map(person=>[person.id,person.exists?publicProfilePhoto(person.data()!,person.id):null]));
  const sender=(person:HumanMessage['sender'])=>({...person,photo:photos.get(person.id)??null});
  return rows.map((r,index)=>({id:r.id,...r.message,sender:sender(r.message.sender),reply:r.message.reply?{...r.message.reply,sender:sender(r.message.reply.sender)}:null,attachments:r.message.attachments??[],reactions:decorated[index].reactions}));
}
export async function readHumanChatMessage(id:string,operator:WithId<Profile>|null,key:unknown,now:()=>number) {
  const messageId=parse(HUMAN_ID,key);
  return inProject(id,()=>db.runTransaction(async tx=>{
    await chatReadAccess(tx,id,operator,now);
    const row=await tx.get(humanMessages(id).doc(messageId));
    if(!row.exists)throw new Refusal('not_found','This message is unavailable.');
    return {message:(await decorateHumanChat(tx,id,operator,[{id:row.id,message:row.data()!}]))[0],serverTime:now()};
  }));
}
const searchCursor=(id:string,q:string,at:number,key:string)=>encodeCursor([`chat-search:${id}:${q}`,at,key]);
export async function searchHumanChat(id:string,operator:WithId<Profile>|null,raw:unknown,rawCursor:unknown,now:()=>number) {
  const q=parse(z.string().trim().min(1).max(120),raw).toLocaleLowerCase();
  let after:Pointer|null=null;
  if(rawCursor!==undefined){try{
    if(typeof rawCursor!=='string'||rawCursor.length>1000)throw new Error();
    const values=decodeCursor(rawCursor);
    if(!Array.isArray(values)||values.length!==3||values[0]!==`chat-search:${id}:${q}`)throw new Error();
    after=POINTER.parse({createdAt:values[1],id:HUMAN_ID.parse(values[2])});
  }catch{throw new Refusal('bad_input','Use this search’s continuation cursor.');}}
  return inProject(id,()=>db.runTransaction(async tx=>{
    const access=await chatReadAccess(tx,id,operator,now);
    let query=humanMessages(id).orderBy('createdAt','desc').orderBy(FieldPath.documentId(),'desc');
    if(after)query=query.startAfter(after.createdAt,after.id);
    const found=await tx.get(query.limit(201)), scanned=found.docs.slice(0,200),last=scanned.at(-1);
    const matches=scanned.filter(row=>{
      const message=row.data();
      return message.body.toLocaleLowerCase().includes(q)||(message.attachments??[]).some(file=>file.name.toLocaleLowerCase().includes(q));
    });
    return {...access,messages:await decorateHumanChat(tx,id,operator,matches.reverse().map(row=>({id:row.id,message:row.data()}))),
      next:found.size>200&&last?searchCursor(id,q,last.data().createdAt,last.id):null,scanned:scanned.length,serverTime:now()};
  }));
}
export async function setChatReaction(id:string,operator:WithId<Profile>,key:unknown,input:unknown,now:()=>number) {
  const messageId=parse(HUMAN_ID,key),body=parse(REACTION,input);
  return inProject(id,()=>db.runTransaction(async tx=>{
    await assertChatWrite(tx,id,operator,now);
    const message=await tx.get(humanMessages(id).doc(messageId));
    if(!message.exists)throw new Refusal('not_found','This message is unavailable.');
    const ref=reactions(id).doc(`human-${messageId}`),own=actor(id,'human',messageId,operator.id);
    const [summary,previous]=await Promise.all([tx.get(ref),tx.get(own)]);
    const emojis=previous.data()?.emojis??[],had=emojis.includes(body.emoji),counts={...summary.data()?.counts};
    if(had!==body.active){
      counts[body.emoji]=Math.max(0,(counts[body.emoji]??0)+(body.active?1:-1));
      tx.set(ref,{counts,updatedAt:FieldValue.serverTimestamp()});tx.set(own,{emojis:body.active?[...emojis,body.emoji]:emojis.filter(value=>value!==body.emoji)});
    }
    const mine=body.active?[...emojis,body.emoji]:emojis.filter(value=>value!==body.emoji);
    return {id:messageId,reactions:['👍','❤️','🎉','👀'].flatMap(emoji=>(counts[emoji]??0)>0?[{emoji,count:counts[emoji],reacted:mine.includes(emoji)}]:[])};
  }));
}
// Like the history reader, an existing reply ID may identify its conversation.
// Store the marker under the canonical root so aliases share one read position.
async function canonicalThread(tx:Transaction,requested:string) {
  const target=(await tx.get(conversationEntries().doc(requested))).data();
  if(!target)return requested;
  return parse(ID,target.threadId);
}
export async function readChatUnread(id:string,operator:WithId<Profile>,rawThreads:unknown,now:()=>number) {
  const threads=rawThreads===undefined?[]:[...new Set(parse(z.string().max(4020),rawThreads).split(','))];
  if(threads.length>20||threads.some(key=>!ID.safeParse(key).success))throw new Refusal('bad_input','Choose up to 20 conversations.');
  return inProject(id,()=>db.runTransaction(async tx=>{
    await assertMembership(tx,operator.id);
    async function unread(channel:Channel,threadId?:string){
      const canonical=channel==='agent'?await canonicalThread(tx,threadId!):undefined;
      const state=await tx.get(stateRef(id,operator.id,channel,canonical)),through=state.data()?.through??null;
      if(channel==='human') {
        let query=humanMessages(id).orderBy('createdAt').orderBy(FieldPath.documentId());
        if(through)query=query.startAfter(through.createdAt,through.id);
        return {count:(await tx.get(query.count())).data().count,through};
      }
      let query=conversationEntries().where('threadId','==',canonical!).orderBy('createdAt').orderBy(FieldPath.documentId());
      if(through)query=query.startAfter(through.createdAt,through.id);
      return {count:(await tx.get(query.count())).data().count,through};
    }
    const human=await unread('human'),agents=await Promise.all(threads.map(async threadId=>({threadId,...await unread('agent',threadId)})));
    return {human,agents,serverTime:now()};
  }));
}
export async function markChatRead(id:string,operator:WithId<Profile>,input:unknown) {
  const body=parse(READ_CHAT,input);
  if(body.channel==='human'&&!HUMAN_ID.safeParse(body.through.id).success)throw new Refusal('bad_input','Choose a message written by a person.');
  return inProject(id,()=>db.runTransaction(async tx=>{
    await assertMembership(tx,operator.id);
    const message=body.channel==='human'?await tx.get(humanMessages(id).doc(body.through.id)):await tx.get(conversationEntries().doc(body.through.id));
    const value=message.data();
    const canonical=body.channel==='agent'?await canonicalThread(tx,body.threadId!):undefined;
    if(!value||value.createdAt!==body.through.createdAt||body.channel==='agent'&&(!('threadId'in value)||value.threadId!==canonical))throw new Refusal('not_found','This message is unavailable in this conversation.');
    const ref=stateRef(id,operator.id,body.channel,canonical),previous=await tx.get(ref);
    const through=previous.data()?.through;
    if(!through||compare(body.through,through)>0)tx.set(ref,{through:body.through});
    return {channel:body.channel,...(canonical?{threadId:canonical}:{}),through:through&&compare(through,body.through)>0?through:body.through};
  }));
}
