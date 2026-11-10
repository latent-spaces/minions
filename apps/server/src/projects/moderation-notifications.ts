import {FieldPath} from '../firestore.js';
import {z} from 'zod';
import type {KarmaNotification,NotificationPage} from '@mlswarm/contracts';
import {collection,db,profiles} from '../firestore.js';
import {Refusal} from '../errors.js';
import {assertMembership} from './access.js';
import {inProject} from '../firestore.js';
import { encodeCursor, decodeCursor } from '../cursor.js';

// Moderation notices sent before moderation was removed (owner decision, 10 November 2026) stay readable.
export const notifications=(profileId:string)=>collection<KarmaNotification>(`profiles/${profileId}/notifications`);

export async function readNotifications(profileId:string,raw:unknown):Promise<NotificationPage> {
  const parsed=z.object({cursor:z.string().max(1500).optional()}).strict().safeParse(raw);
  if(!parsed.success)throw new Refusal('bad_input','Use the notification cursor returned by the bell.');
  const cursor=parsed.data.cursor?decodeCursor(parsed.data.cursor):null;
  if(parsed.data.cursor&&(!cursor||cursor.length!==3||cursor[0]!==profileId||typeof cursor[1]!=='number'||typeof cursor[2]!=='string'||!/^[a-f0-9]{64}$/.test(cursor[2])))throw new Refusal('bad_input','Use this account’s notification cursor.');
  return db.runTransaction(async tx=>{
    const person=(await tx.get(profiles.doc(profileId))).data();
    if(!person||person.removedAt!==null)throw new Refusal('unauthorized','Your account is no longer active.');
    let query=notifications(profileId).where('readAt','==',null).orderBy('createdAt','desc').orderBy(FieldPath.documentId(),'desc').limit(21);
    if(cursor)query=query.startAfter(cursor[1],cursor[2]);
    const docs=await tx.get(query),page=docs.docs.slice(0,20),items=[];
    for(const doc of page){const notice=doc.data();try{await inProject(notice.projectId,()=>assertMembership(tx,profileId));items.push(notice);}catch(error){if(!(error instanceof Refusal&&error.code==='unauthorized'))throw error;}}
    const last=page.at(-1);
    return {items,next:docs.size>20&&last?encodeCursor([profileId,last.data().createdAt,last.id]):null};
  });
}
export async function markNotificationRead(profileId:string,id:string,now:()=>number) {
  if(!/^[a-f0-9]{64}$/.test(id))throw new Refusal('not_found','Notification unavailable.');
  return db.runTransaction(async tx=>{
    const person=(await tx.get(profiles.doc(profileId))).data(),ref=notifications(profileId).doc(id),notice=(await tx.get(ref)).data();
    if(!person||person.removedAt!==null)throw new Refusal('unauthorized','Your account is no longer active.');
    if(!notice)throw new Refusal('not_found','Notification unavailable.');
    if(notice.readAt===null)tx.update(ref,{readAt:now()});
    return {ok:true};
  });
}
/** Marks every unread notice of this person read in batches of 400; repeating it is a no-op. */
export async function markAllNotificationsRead(profileId:string,now:()=>number) {
  const person=(await profiles.doc(profileId).get()).data();
  if(!person||person.removedAt!==null)throw new Refusal('unauthorized','Your account is no longer active.');
  const at=now();let marked=0;
  for(;;){
    const unread=await notifications(profileId).where('readAt','==',null).limit(400).get();
    if(unread.empty)break;
    const batch=db.batch();for(const doc of unread.docs)batch.update(doc.ref,{readAt:at});
    await batch.commit();marked+=unread.size;
    if(unread.size<400)break;
  }
  return {ok:true,marked};
}
