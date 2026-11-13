import { prepareProjectJourney } from '../onboarding/journeys.js';
// Human discussion is separate from agent messages: no delivery, wake or model instructions.
import express, { type Request, type Response } from 'express';
import { FieldPath } from '../firestore.js';
import { z } from 'zod';
import { hashToken, personFromIdToken } from '../auth.js';
import { bearerToken } from '../bearer.js';
import { collection, db, inProject, profiles, type Profile, type WithId } from '../firestore.js';
import { validProjectId } from './access.js';
import { Refusal, sendRefusal } from '../errors.js';
import { requestLimits } from '../request-state.js';

import { assertChatWrite, chatReadAccess, humanMessages, type HumanMessage } from './chat-records.js';
import { decorateHumanChat, readHumanChatMessage, searchHumanChat, setChatReaction, readChatUnread, markChatRead } from './chat-support.js';
import { validateChatAttachments, commitChatAttachments } from './chat-media.js';
import { decodeCursor, encodeCursor } from '../cursor.js';

const CHAT_MESSAGE = z.object({ client_request_id: z.string().uuid(), body: z.string().trim().max(2000), replyTo: z.string().regex(/^[a-f0-9]{64}$/).optional(), attachmentIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,200}$/)).max(3).optional() }).strict().refine(value => value.body.length > 0 || !!value.attachmentIds?.length);
// Cut quotes on a whole character: a lone surrogate half would be stored as U+FFFD.
const replyQuote = (body: string) => body.slice(0, 300).replace(/[\uD800-\uDBFF]$/, '');
export const humanChatSendState = (id: string) => collection<{ lastSentAt: number }>(`projects/${id}/humanChatSendState`);
const encoded = (id: string, at: number, key: string) => encodeCursor([id, at, key]);
function decode(id: string, cursor: unknown): [number, string] | null {
  if (cursor === undefined) return null;
  try {
    if (typeof cursor !== 'string' || cursor.length > 500) throw new Error();
    const [scope, at, key, extra] = (decodeCursor(cursor) ?? []) as [unknown, number, unknown, unknown];
    if (scope !== id || extra !== undefined || !Number.isSafeInteger(at) || at < 0 || typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) throw new Error();
    return [at, key];
  } catch { throw new Refusal('bad_input', 'Use the older-messages link for this project.'); }
}
export async function readHumanChat(id: string, operator: WithId<Profile> | null, cursor: unknown, now: () => number, size = 50) {
  const after = decode(id, cursor);
  return inProject(id, () => db.runTransaction(async tx => {
    const access = await chatReadAccess(tx, id, operator, now);
    let query = humanMessages(id).orderBy('createdAt', 'desc').orderBy(FieldPath.documentId(), 'desc');
    if (after) query = query.startAfter(...after);
    const rows = await tx.get(query.limit(size + 1)), page = rows.docs.slice(0, size), last = page.at(-1);
    return { ...access,
      messages: await decorateHumanChat(tx, id, operator, [...page].reverse().map(d => ({ id: d.id, message: d.data() }))),
      next: rows.size > size && last ? encoded(id, last.data().createdAt, last.id) : null, serverTime: now() };
  }));
}
async function sendHumanMessage(id: string, operator: WithId<Profile>, input: z.infer<typeof CHAT_MESSAGE>, now: () => number) {
  const parsed = CHAT_MESSAGE.safeParse(input);
  if (!parsed.success) throw new Refusal('bad_input', 'Write a message of up to 2,000 characters or attach a file.');
  const body = parsed.data.body, messageId = hashToken(`${operator.id}:${parsed.data.client_request_id}`);
  return inProject(id, () => db.runTransaction(async tx => {
    await assertChatWrite(tx, id, operator, now);
    const ref = humanMessages(id).doc(messageId), state = humanChatSendState(id).doc(operator.id);
    const [previous, recent, person] = await Promise.all([tx.get(ref), tx.get(state), tx.get(profiles.doc(operator.id))]);
    if (previous.exists) {
      if (previous.data()!.body !== body || (previous.data()!.reply?.id ?? null) !== (parsed.data.replyTo ?? null) || JSON.stringify((previous.data()!.attachments ?? []).map(a => a.id)) !== JSON.stringify(parsed.data.attachmentIds ?? [])) throw new Refusal('intent_conflict', 'This request ID was already used with different details. Send the original request again, or use a new request ID.');
      return { message: (await decorateHumanChat(tx,id,operator,[{id:messageId,message:previous.data()!}]))[0], replayed: true };
    }
    const reply = parsed.data.replyTo ? await tx.get(humanMessages(id).doc(parsed.data.replyTo)) : null;
    if (reply && !reply.exists) throw new Refusal('not_found', 'The message you are replying to is unavailable.');
    const attachments = await validateChatAttachments(tx, id, operator.id, parsed.data.attachmentIds ?? [], messageId);
    const at = now();
    if (recent.exists && at - recent.data()!.lastSentAt < 2000) throw new Refusal('rate_limited', 'Wait two seconds before sending another message.', 2);
    const rawName = person.data()!.name;
    const message: HumanMessage = { sender: { id: operator.id, name: rawName.includes('@') ? 'Project member' : rawName }, body, createdAt: at, reply: reply ? { id: reply.id, body: replyQuote(reply.data()!.body), sender: reply.data()!.sender } : null, attachments };
    const receipt=(await decorateHumanChat(tx,id,operator,[{id:messageId,message}]))[0];
    const progress = await prepareProjectJourney(tx, operator.id, id, at);
    progress(['firstChat'], 'chat');
    commitChatAttachments(tx, id, parsed.data.attachmentIds ?? [], messageId);
    tx.create(ref, message); tx.set(state, { lastSentAt: at });
    return { message: receipt, replayed: false };
  }));
}
function fail(res: Response, error: unknown) {
  if (error instanceof Refusal) sendRefusal(res, error);
  else { console.error('Human chat request failed', error); res.status(500).json({ error: 'internal_error', message: 'Something went wrong sending this message. Try sending it again.' }); }
}
async function person(req: Request) {
  const token = bearerToken(req.headers.authorization);
  if (!token) throw new Refusal('unauthorized', 'Sign in to send a message.');
  return personFromIdToken(token);
}
// A rejected token reads as a guest; a sign-in outage stays a retryable failure instead of hiding a private chat.
async function readOperator(req: Request) {
  if (!req.headers.authorization) return null;
  return person(req).catch((error: unknown) => { if (error instanceof Refusal) return null; throw error; });
}
export function humanChatRoutes(now: () => number) {
  const router = express.Router(); router.use(express.json({ limit: '12kb' }));
  const writes = requestLimits.limiter(() => 'human-chat-write', 60, 60_000);
  const admit = (limit: (key: string, at: number) => number, key: string) => { const retry = limit(key, now()); if (retry) throw new Refusal('rate_limited', 'Chat is busy. Wait a moment, then try again.', Math.ceil(retry / 1000)); };
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!validProjectId(req.params.id) && !validProjectId(req.path.split('/')[1])) { fail(res, new Refusal('not_found', 'This chat is unavailable.')); return; }
    next();
  });
  router.get('/:id', (req, res) => {
    void (async () => {
      if (Object.keys(req.query).some(key => key !== 'cursor')) throw new Refusal('bad_input', 'Use the chat’s pagination controls.');
      const operator = await readOperator(req);
      return readHumanChat(String(req.params.id), operator, req.query.cursor, now);
    })().then(value => res.json(value), error => fail(res, error));
  });
  router.post('/:id', (req, res) => {
    void person(req).then(operator => { admit(writes, operator.id); return sendHumanMessage(String(req.params.id), operator, req.body, now); })
      .then(value => res.json(value), error => fail(res, error));
  });
  // All interactions retain the same human-account and current-membership checks.
  router.get('/:id/search', (req, res) => {
    void readOperator(req).then(operator => searchHumanChat(String(req.params.id), operator, req.query.q, req.query.cursor, now))
      .then(value => res.json(value), error => fail(res, error));
  });
  router.get('/:id/messages/:messageId', (req, res) => {
    void readOperator(req).then(operator => readHumanChatMessage(String(req.params.id), operator, req.params.messageId, now))
      .then(value => res.json(value), error => fail(res, error));
  });
  // Reactions are human feedback on human messages; agents never receive them, so agent messages take none.
  router.post('/:id/messages/:messageId/reactions', (req,res) => {
    void person(req).then(operator => { admit(writes,operator.id); return setChatReaction(String(req.params.id),operator,req.params.messageId,req.body,now); }).then(value=>res.json(value),error=>fail(res,error));
  });
  router.get('/:id/unread', (req,res) => {
    void person(req).then(operator => readChatUnread(String(req.params.id),operator,req.query.threads,now)).then(value=>res.json(value),error=>fail(res,error));
  });
  router.post('/:id/read', (req,res) => {
    void person(req).then(operator => { admit(writes,operator.id); return markChatRead(String(req.params.id),operator,req.body); }).then(value=>res.json(value),error=>fail(res,error));
  });
  return router;
}
