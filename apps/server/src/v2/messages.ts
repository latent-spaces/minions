import { conversationEntries } from '../projects/steering.js';
import { runtimeOf } from '../projects/records.js';
import { FieldPath, type Transaction } from '../firestore.js';
import { LIMITS, V2_LIMITS } from '../config.js';
import { Refusal } from '../errors.js';
import { agents, db, projectDoc, type Agent, type WithId } from '../firestore.js';
import { assertCanDiscuss } from '../store/project-policy.js';
import { createFanout, deliverProjectWide } from './fanout.js';
import { backlog, deliver, readTargets } from './inbox.js';
import { messagesV2, type MessageV2 } from './records.js';

import { activeRecipientOperators, connectionAllowed, assertAgentMembership } from '../projects/access.js';
import { assertRunInTransaction } from './runs.js';
import { communicationUsageDoc, resolveCommunication, sharedBroadcastLimit } from '../projects/communication.js';
import { messageWithSource, type WithSource } from './untrusted.js';
import { AGENT_TEXT_LIMIT } from '@minions/contracts';
import { decodeCursor, encodeCursor } from '../cursor.js';

const HOUR_MS = 3_600_000;
// These values become Firestore document ids, where a slash would point at another collection.
const CLIENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const DOC_ID = /^[A-Za-z0-9_-]{1,100}$/;
const THREAD_ID = /^[A-Za-z0-9_-]{1,200}$/;
export const PROJECT = 'project';
const ABORTED = 10;  // the gRPC status codes
const INVALID_ARGUMENT = 3;

// Sends to the agents in `to`, or to the whole project when `to` is ["project"]. A direct message is
// in each recipient's inbox when this returns: the message and the deliveries are one transaction.
// Sending again with the same clientId returns the first message, so a retry never sends twice.
export async function sendMessageV2(agent: WithId<Agent>, input: {
  to: string[], body: string, summary?: string, threadId?: string, clientId: string
}, now: () => number, runId?: string): Promise<{ message: MessageV2, duplicate: boolean }> {
  if (!CLIENT_ID.test(input.clientId)) {
    throw new Refusal('bad_input', 'client_message_id must be 1 to 64 letters, digits, hyphens or underscores.');
  }
  if (input.summary !== undefined && (typeof input.summary !== 'string' || !input.summary.trim()
    || [...input.summary].length > AGENT_TEXT_LIMIT || /[\r\n\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(input.summary))) {
    throw new Refusal('bad_input', `Keep the summary to one line of up to ${AGENT_TEXT_LIMIT} characters.`);
  }
  const projectWide = input.to.length === 1 && input.to[0] === PROJECT;
  const to = [...new Set(input.to)];
  if (!projectWide && to.length) checkRecipients(to, agent.id);
  const ref = messagesV2().doc(`${agent.id}_${input.clientId}`);

  const sent = await db.runTransaction(async (tx) => {
    await (runId ? assertRunInTransaction(tx, agent.id, runId)
      : assertAgentMembership(tx, agent.id));
    const existing = (await tx.get(ref)).data();
    if (existing) {
      // A retry returns the first message; reusing the ID for a different one would silently drop it.
      if (!await sameSend(tx, existing, input, projectWide ? [PROJECT] : to)) {
        throw new Refusal('intent_conflict', 'This client_message_id was already used for a different message. '
          + 'Nothing was sent. Send the original message again, or use a new client_message_id.');
      }
      return { message: existing, duplicate: true, fanoutId: null };
    }

    const at = now();
    const project = runtimeOf((await tx.get(projectDoc())).data());
    if (!project) throw new Refusal('not_found', 'This project isn’t set up yet. Ask the owner to finish setting it up.');
    assertCanDiscuss(project);
    if (input.body.trim() === '') throw new Refusal('bad_input', 'A message needs some text.');
    // Count characters, as private messages and updates do, so emoji and other astral text are not
    // counted twice. The UTF-16 bound only caps storage.
    const chars = [...input.body].length;
    if (chars > LIMITS.messageMaxChars || input.body.length > 2 * LIMITS.messageMaxChars) {
      throw new Refusal('too_long',
        `A message can have at most ${LIMITS.messageMaxChars} characters. This one has ${chars}.`);
    }

    // A reply to a reply joins the same thread.
    let threadId = ref.id;
    if (input.threadId !== undefined) {
      const target = THREAD_ID.test(input.threadId) ? (await tx.get(conversationEntries().doc(input.threadId))).data() : undefined;
      if (target?.protocol !== 2) throw new Refusal('not_found', `There is no thread ${input.threadId}.`);
      threadId = target.threadId;
    }

    if(!projectWide && !to.length){
      const root=input.threadId?(await tx.get(conversationEntries().doc(threadId))).data():undefined;
      if(root?.kind!=='steering')throw new Refusal('bad_input','An empty recipient list is only for a reply to human steering.');
    }

    const self = (await tx.get(agents().doc(agent.id))).data();
    if (!self || self.revokedAt !== null) throw new Refusal('unauthorized', 'This agent was removed from the project.');
    const policy = await resolveCommunication(tx);
    const recentSends = (self.recentSends ?? []).filter(t => at - t < HOUR_MS);
    const recentProjectSends = (self.recentProjectSends ?? []).filter(t => at - t < HOUR_MS);
    assertMayPost(msUntil(recentSends, at, policy.minimumGapSeconds, policy.sendsPerHour),
      `This agent can send once every ${policy.minimumGapSeconds} seconds and ${policy.sendsPerHour} times an hour.`);

    let targets: Awaited<ReturnType<typeof readTargets>> = [];
    let recentBroadcasts: number[] = [];
    if (projectWide) {
      if (!policy.broadcastAllowed) {
        throw new Refusal('forbidden', 'Messages to the whole project are turned off in this project. Name up to '
          + `${V2_LIMITS.recipientsMax} agents in \`to\` instead.`);
      }
      assertMayPost(msUntil(recentProjectSends, at, 0, policy.broadcastsPerHour),
        `This agent can message the whole project ${policy.broadcastsPerHour} times an hour.`);
      const usage = (await tx.get(communicationUsageDoc())).data();
      const shared = await sharedBroadcastLimit(tx, policy.sharedBroadcastsPerHour);
      // A missing counter must not forgive broadcasts beyond an old fixed page.
      // Read up to the current allowance, newest first. If that many are recent,
      // admission fails below and no truncated history is persisted. Otherwise
      // this contains the complete recent history; the next send saves it intact.
      const history = usage === undefined
        ? (await tx.get(messagesV2().where('audience', '==', 'project').orderBy('createdAt', 'desc').limit(shared))).docs.map(d => d.data().createdAt)
        : usage.recentBroadcasts;
      recentBroadcasts = history.filter(t => at - t < HOUR_MS).sort((a, b) => a - b);
      assertMayPost(msUntil(recentBroadcasts, at, 0, shared),
        `The project can accept ${shared} broadcasts in total per hour (${policy.sharedBroadcastsPerHour} per agent in the team).`);
    } else if(to.length) {
      const recipients = await tx.getAll(...to.map((id) => agents().doc(id)));
      const eligible = recipients.filter(d => d.exists && d.data()!.revokedAt === null);
      const operators = await activeRecipientOperators(tx, eligible.map(d => d.data()!.ownerProfileId));
      for (const [i, recipient] of recipients.entries()) {
        if (!recipient.exists || recipient.data()!.revokedAt !== null || !connectionAllowed(recipient.data()!, operators)) {
          throw new Refusal('not_found', `There is no agent ${to[i]} in this project. Nothing was sent.`);
        }
      }
      targets = await readTargets(tx, to, ref.id);
      for (const target of targets) {
        if (backlog(target.inbox) >= V2_LIMITS.backlogMax) {
          throw new Refusal('recipient_backlog', `Agent ${target.agentId} has ${backlog(target.inbox)} messages it `
            + 'hasn’t handled yet, so it can’t take more right now. Nothing was sent. Don’t wait for it in this turn.',
          60);
        }
      }
    }

    const message: MessageV2 = {
      id: ref.id, agentId: agent.id, agentName: self.name, threadId, body: input.body,
      ...(input.summary === undefined ? {} : { summary: input.summary.trim() }),
      to: projectWide ? [PROJECT] : to, audience: projectWide ? 'project' : 'direct', createdAt: at, protocol: 2,
    };
    tx.set(ref, message);
    tx.create(conversationEntries().doc(message.id), {...message,kind:'agent_message'});
    tx.update(agents().doc(agent.id), {
      recentSends: [...recentSends, at],
      ...(projectWide ? { recentProjectSends: [...recentProjectSends, at] } : {}),
    });
    if (projectWide) {
      tx.set(communicationUsageDoc(), { recentBroadcasts: [...recentBroadcasts, at] });
      const fanoutId = createFanout(tx, 'announcement', message, at, { id: ref.id, senderId: agent.id });
      return { message, duplicate: false, fanoutId };
    }
    deliver(tx, targets, { sourceId: ref.id, kind: 'message', messageId: ref.id, payload: message }, at);
    return { message, duplicate: false, fanoutId: null };
  }, { maxAttempts: 2 }).catch((error) => {
    // Allow one backoff retry to break a simultaneous read/write collision, then return contention.
    // Do not retain the SDK default five attempts inside one HTTP call.
    // The stable clientId remains the retry identity; successful sends still commit delivery atomically.
    // Firestore rejected the transaction because too many others wrote
    // the same inboxes at once (seen on the emulator with 50 senders to one agent). The emulator also
    // reports a transaction that waited too long as INVALID_ARGUMENT "invalid or closed". Nothing was written.
    const busy = error?.code === ABORTED
      || (error?.code === INVALID_ARGUMENT && /Transaction is invalid or closed/.test(String(error?.details)));
    if (!busy) throw error;
    throw new Refusal('project_busy', 'Too many messages are going to these agents right now. Nothing was '
      + 'sent. Send it again later with the same client_message_id; don’t wait for it in this turn.', 5);
  });

  // Runs a bounded fanout slice before answering, beside the private worker. A retry also continues it.
  const fanoutId = sent.fanoutId ?? (sent.message.audience === 'project' ? sent.message.id : null);
  if (fanoutId) await deliverProjectWide(fanoutId, now);
  return { message: sent.message, duplicate: sent.duplicate };
}

// Same text, recipients and thread as the saved message. Recipient order does not matter.
async function sameSend(tx: Transaction, saved: MessageV2, input: { to: string[], body: string, summary?: string, threadId?: string },
  to: string[]): Promise<boolean> {
  const recipients = (ids: string[]) => JSON.stringify([...new Set(ids)].sort());
  if (saved.body !== input.body || (saved.summary ?? undefined) !== input.summary?.trim()
    || recipients(saved.to) !== recipients(to)) return false;
  if (input.threadId === undefined) return saved.threadId === saved.id;
  if (input.threadId === saved.threadId) return true;
  const target = THREAD_ID.test(input.threadId) ? (await tx.get(conversationEntries().doc(input.threadId))).data() : undefined;
  return target?.threadId === saved.threadId;
}

function checkRecipients(to: string[], selfId: string): void {
  if (to.length < 1 || to.length > V2_LIMITS.recipientsMax) {
    throw new Refusal('bad_input', `Name 1 to ${V2_LIMITS.recipientsMax} agents in \`to\`, using ids from find_agents.`);
  }
  for (const id of to) {
    if (id === PROJECT) throw new Refusal('bad_input', 'To send to the whole project, `to` must be ["project"] alone.');
    if (!DOC_ID.test(id)) throw new Refusal('not_found', `There is no agent ${id} in this project. Nothing was sent.`);
    if (id === selfId) throw new Refusal('bad_input', 'You cannot send a message to yourself.');
  }
}

function assertMayPost(waitMs: number, rule: string): void {
  if (waitMs <= 0) return;
  const seconds = Math.ceil(waitMs / 1000);
  throw new Refusal('rate_limited',
    `${rule} You can send the next one in ${seconds} second${seconds === 1 ? '' : 's'}. Don’t wait for it in this turn.`,
    seconds);
}

// History is retained independently of the mutable allowance, oldest first.
function msUntil(times: number[], at: number, minSeconds: number, perHour: number): number {
  const last = times.length ? Math.max(...times) : undefined;
  const gap = last === undefined || minSeconds === 0 ? 0 : last + minSeconds * 1000 - at;
  const inLastHour = times.filter((t) => at - t < HOUR_MS).sort((a, b) => a - b);
  const hourly = inLastHour.length >= perHour ? inLastHour[inLastHour.length - perHour] + HOUR_MS - at : 0;
  return Math.max(gap, hourly);
}

// A page of a thread, oldest first: at most limit messages (pageItems unless given) or pageBytes of them, and a cursor
// for the next page when there is one. Accepts the id of any message in the thread.
// Bodies are enveloped as untrusted text, and the page budget counts the envelopes.
export async function readThreadPage(threadId: string, cursor?: string, afterMessageId?: string, limit: number = V2_LIMITS.pageItems): Promise<{
  messages: WithSource<MessageV2>[], next: string | null
}> {
  const target = THREAD_ID.test(threadId) ? (await conversationEntries().doc(threadId).get()).data() : undefined;
  if (target?.protocol !== 2) throw new Refusal('not_found', `There is no thread ${threadId}.`);
  if (cursor !== undefined && afterMessageId !== undefined) {
    throw new Refusal('bad_input', 'Use cursor or after_message_id, not both.');
  }
  let query = conversationEntries().where('threadId', '==', target.threadId)
    .orderBy('createdAt').orderBy(FieldPath.documentId()).limit(limit + 1);
  if (cursor !== undefined) {
    // Exactly the thread and the two ordered fields: extra values would fail inside Firestore.
    const after = decodeCursor(cursor);
    if (!after || after.length !== 3 || after[0] !== target.threadId || !Number.isSafeInteger(after[1])
      || typeof after[2] !== 'string' || !THREAD_ID.test(after[2])) {
      throw new Refusal('bad_input', 'That cursor is not one read_thread returned for this thread.');
    }
    query = query.startAfter(after[1], after[2]);
  }
  if (afterMessageId !== undefined) {
    const anchor = THREAD_ID.test(afterMessageId) ? (await conversationEntries().doc(afterMessageId).get()).data() : undefined;
    if (anchor?.protocol !== 2 || anchor.threadId !== target.threadId) {
      throw new Refusal('bad_input', 'after_message_id must identify a message in this thread.');
    }
    query = query.startAfter(anchor.createdAt, anchor.id);
  }
  const found = await query.get();
  const page: WithSource<MessageV2>[] = [];
  let bytes = 0;
  for (const doc of found.docs.slice(0, limit)) {
    const message = messageWithSource(doc.data());
    bytes += Buffer.byteLength(JSON.stringify(message));
    if (page.length > 0 && bytes > V2_LIMITS.pageBytes) break;
    page.push(message);
  }
  const last = page.at(-1);
  return { messages: page, next: found.size > page.length && last ? encodeCursor([target.threadId, last.createdAt, last.id]) : null };
}

