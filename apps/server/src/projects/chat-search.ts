import { conversationSource } from '../view/conversation-source.js';
import { createHash } from 'node:crypto';
import { FieldPath } from '../firestore.js';
import { currentProjectId, db } from '../firestore.js';
import { Refusal } from '../errors.js';
import { messagesV2, type MessageV2 } from '../v2/records.js';
import { decodeCursor, encodeCursor } from '../cursor.js';

export const sharedAgentMessage = (m: MessageV2 | undefined): m is MessageV2 => !!m
  && m.audience === 'project' && m.to.length === 1 && m.to[0] === 'project';

// Search scans bounded windows and exposes continuation even when a window has no matches.
// It never silently presents the loaded latest page as complete project history.
export async function searchAgentMessages(input: { q: unknown; cursor: unknown; threadId?: string; publicOnly?: boolean }) {
  if (typeof input.q !== 'string' || !input.q.trim() || input.q.trim().length > 100)
    throw new Refusal('bad_input', 'Search using 1–100 characters.');
  const q = input.q.trim().toLocaleLowerCase('en-US');
  const scope = createHash('sha256').update(JSON.stringify([currentProjectId(), input.threadId ?? null, !!input.publicOnly, q])).digest('hex');
  let after: [number, string] | null = null;
  if (input.cursor !== undefined) {
    try {
      if (typeof input.cursor !== 'string' || input.cursor.length > 500) throw new Error();
      const values = decodeCursor(input.cursor);
      if (!Array.isArray(values) || values.length !== 3 || values[0] !== scope || !Number.isSafeInteger(values[1])
        || (values[1] as number) < 0 || typeof values[2] !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(values[2])) throw new Error();
      after = [values[1] as number, values[2]];
    } catch { throw new Refusal('bad_input', 'Use this search’s continuation cursor.'); }
  }
  let query = messagesV2().orderBy('createdAt', 'desc').orderBy(FieldPath.documentId(), 'desc');
  if (input.threadId) query = query.where('threadId', '==', input.threadId);
  if (input.publicOnly) query = query.where('audience', '==', 'project');
  if (after) query = query.startAfter(...after);
  const found = await query.limit(201).get(), page = found.docs.slice(0, 200);
  const matches = (row: MessageV2) => [row.body, row.summary ?? ''].some(text => text.toLocaleLowerCase('en-US').includes(q));
  const candidates = page.filter(doc => matches(doc.data())
    && (!input.publicOnly || sharedAgentMessage(doc.data())));
  const rootIds = input.publicOnly ? [...new Set(candidates.map(doc => doc.data().threadId))]
    .filter(id => /^[A-Za-z0-9_-]{1,200}$/.test(id)) : [];
  const roots = rootIds.length ? await db.getAll(...rootIds.map(id => messagesV2().doc(id))) : [];
  const sharedRoots = new Set(roots.filter(doc => sharedAgentMessage(doc.data() as MessageV2 | undefined)).map(doc => doc.id));
  const messages: MessageV2[] = [];
  let scanned = 0;
  for (const doc of page) {
    scanned++;
    const row = doc.data();
    if (matches(row)
      && (!input.publicOnly || sharedAgentMessage(row) && sharedRoots.has(row.threadId))) messages.push(row);
    if (messages.length === 50) break;
  }
  const last = page[scanned - 1], more = scanned < page.length || found.size > 200;
  return { messages: messages.reverse(), scanned,
    next: more && last ? encodeCursor([scope, last.data().createdAt, last.id]) : null };
}

// The member-only Conversations index never reads old private steering records.
export async function searchConversationMessages(input: {q:unknown;cursor:unknown;threadId?:string;profileId?:string}) {
  if(typeof input.q!=='string'||!input.q.trim()||input.q.trim().length>100)throw new Refusal('bad_input','Search using 1–100 characters.');
  const q=input.q.trim().toLocaleLowerCase('en-US'),scope=createHash('sha256').update(JSON.stringify(['conversations',currentProjectId(),input.threadId??null,q,input.profileId??null])).digest('hex');
  const source=await conversationSource(input.profileId);
  let after: [number,string]|null=null;
  if(input.cursor!==undefined){const cursor=typeof input.cursor==='string'&&input.cursor.length<=500?decodeCursor(input.cursor):null;
    if(!Array.isArray(cursor)||cursor.length!==3||cursor[0]!==scope||!Number.isSafeInteger(cursor[1])||(cursor[1] as number)<0||typeof cursor[2]!=='string'||!/^[\w-]{1,200}$/.test(cursor[2]))throw new Refusal('bad_input','Use this search cursor.');after=[cursor[1] as number,cursor[2]];}
  const found=await source.window({threadId:input.threadId,after,limit:201}),page=found.slice(0,200),last=page.at(-1);
  return {messages:page.filter(m=>(m.body+' '+(m.summary??'')).toLocaleLowerCase('en-US').includes(q)).reverse(),scanned:page.length,next:found.length>200&&last?encodeCursor([scope,last.createdAt,last.id]):null};
}
