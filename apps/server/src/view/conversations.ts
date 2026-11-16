import { runnerUsage } from '../v2/records.js';
// Agent conversations as members read them, on the website's Conversations tab and through the
// person's MCP. Both call these inside the project's context after checking membership. Reads only:
// no read marker, inbox or cursor moves.
import { conversationSource } from './conversation-source.js';
import { conversationEntries, type ConversationEntry } from '../projects/steering.js';
import { personaChoice } from '@minions/contracts';
import { publicPersonAppearance } from '../community/profile-photo-ref.js';
import { Refusal } from '../errors.js';
import { agents, currentProjectId, db, profiles, type Profile } from '../firestore.js';
import { decodeCursor, encodeCursor } from '../cursor.js';
import type { MessageV2 } from '../v2/records.js';

const THREAD_PAGE = 50;
// A conversations page lists up to 20 (or the caller's limit), reading the newest messages 50 at a time and at most 200 in all.
const CONVERSATIONS_PAGE = 20;
const CONVERSATION_BATCH = 50;
const CONVERSATION_SCAN = 200;

// One thread, newest first on the wire, displayed chronologically.
export async function readThread(id: string, query: { cursor?: unknown; order?: unknown }, now: () => number, profileId?: string, size = THREAD_PAGE) {
  const target = /^[A-Za-z0-9_-]{1,200}$/.test(id) ? (await conversationEntries().doc(id).get()).data() : undefined;
  if (!target) throw new Refusal('not_found', 'This conversation is unavailable.');
  const rootId = target.threadId;
  if (query.order !== undefined && query.order !== 'latest') throw new Refusal('bad_input', 'Use latest thread history.');
  const scope = `thread:${currentProjectId()}:${rootId}${profileId ? `:mine:${profileId}` : ''}`;
  const after = messageCursor(query.cursor, scope);
  const source = await conversationSource(profileId);
  const [found, count] = await Promise.all([
    source.window({ threadId: rootId, after, limit: size + 1 }), source.count(rootId),
  ]);
  const page = found.slice(0, size);
  const last = page.at(-1);
  return {
    threadId: rootId,
    count,
    messages: await present([...page].reverse()),
    next: found.length > size && last ? encodeCursor([scope, last.createdAt, last.id]) : null,
    serverTime: now(),
  };
}

// Conversations, latest activity first. The newest messages are read in batches and grouped by thread
// until a page is full. Each conversation is listed once, on the page that holds its latest message.
export async function readConversations(value: unknown, now: () => number, profileId?: string, limit = CONVERSATIONS_PAGE) {
  const scope = `conversations:${currentProjectId()}${profileId ? `:mine:${profileId}` : ''}`;
  const after = messageCursor(value, scope);
  const source = await conversationSource(profileId);
  const seen = new Set<string>();
  const latest = new Map<string, ConversationEntry>();
  let cursor = after, scanned = 0, full = false, end = false;
  while (!full && !end && scanned < CONVERSATION_SCAN) {
    // One extra row says whether more messages exist, so a page that reads the last ones offers no next page.
    const found = await source.window({ after: cursor, limit: CONVERSATION_BATCH + 1 });
    end = found.length <= CONVERSATION_BATCH;
    const batch = found.slice(0, CONVERSATION_BATCH);
    const fresh = [...new Set(batch.map((m) => m.threadId))].filter((id) => !seen.has(id));
    // A thread with a message at or after the cursor was listed on a newer page. This scan is contiguous
    // from the cursor, so one query per new thread decides it.
    const newer = after ? await Promise.all(fresh.map(async id =>
      (await source.window({ threadId: id, ascending: true, startAt: after, limit: 1 })).length > 0)) : [];
    const skipped = new Set(fresh.filter((_, i) => newer[i]));
    for (const m of batch) {
      const id = m.threadId;
      if (!seen.has(id)) {
        // The next page starts with the first conversation that does not fit.
        if (!skipped.has(id) && latest.size === limit) { full = true; break; }
        seen.add(id);
        if (!skipped.has(id)) latest.set(id, m);
      }
      cursor = [m.createdAt, m.id];
      scanned++;
    }
  }
  const ids = [...latest.keys()];
  const [roots, counts] = await Promise.all([
    profileId ? Promise.all(ids.map(async id => (await source.window({ threadId: id, ascending: true, limit: 1 }))[0]))
      : (async () => ids.length ? (await db.getAll(...ids.map(id => conversationEntries().doc(id)))).map(row => row.data()) : [])(),
    Promise.all(ids.map(id => source.count(id))),
  ]);
  const first = roots as (ConversationEntry | undefined)[];
  const shown = await present([...latest.values(), ...first.filter((m) => m !== undefined)]);
  const byId = new Map(shown.map((m) => [m.id, m]));
  return {
    conversations: ids.map((id, i) => ({
      threadId: id,
      count: counts[i],
      first: first[i] ? byId.get(first[i].id)! : null,
      latest: byId.get(latest.get(id)!.id)!,
    })),
    next: (full || !end) && cursor ? encodeCursor([scope, ...cursor]) : null,
    serverTime: now(),
  };
}

// Adds each agent's name, owner and persona, for the sender and every recipient alike.
export async function present(list: (MessageV2 | ConversationEntry)[]) {
  const ids = new Set<string>();
  for (const m of list) for (const id of m.to) if (id !== 'project') ids.add(id);
  for (const m of list) ids.add(m.agentId);
  const agentDocs = ids.size ? await db.getAll(...[...ids].map(id => agents().doc(id))) : [];
  const names = new Map(agentDocs.filter(doc => doc.exists).map(doc => [doc.id, doc.data()!.name]));
  const owners = new Map(agentDocs.filter(doc => doc.exists).map(doc => [doc.id, doc.data()!.ownerProfileId]));
  const personas = new Map(agentDocs.filter(doc => doc.exists).map(doc => [doc.id, personaChoice(doc.data()!.persona?.text ?? '')]));
  const ownerIds = [...new Set([...owners.values(), ...list.flatMap(m => 'kind' in m && m.kind === 'steering' ? [m.actorProfileId] : [])])];
  const ownerDocs = ownerIds.length ? await db.getAll(...ownerIds.map(id => profiles.doc(id))) : [];
  const people = new Map(ownerDocs.filter(doc => doc.exists && doc.data()!.removedAt === null).map(doc => [doc.id, { name: doc.data()!.name, ...publicPersonAppearance(doc.data()! as Profile, doc.id) }]));
  const usage = agentDocs.length ? await db.getAll(...agentDocs.map(doc => runnerUsage().doc(doc.id))) : [];
  const providers = new Map(agentDocs.map((doc, index) => [doc.id, usage[index]?.get('provider')]));
  const agent = (id: string) => {
    const owner = owners.get(id);
    const person = owner ? people.get(owner) : undefined;
    return { ...(providers.get(id) ? { provider: providers.get(id) } : {}), operatorId: person ? owner! : null, operatorName: person?.name ?? null, operatorPhoto: person?.photo ?? null, personaChoice: personas.get(id) ?? null };
  };
  return list.map((m) => ({
    ...(('kind' in m && m.kind==='steering') ? {steering:{state:m.state,origin:m.origin,observedAt:m.observedAt,...(m.deliveries?{deliveries:m.deliveries.map(d=>({agentId:d.agentId,agentName:d.agentName,state:d.state,observedAt:d.observedAt}))}:{})}}:{}),
    id: m.id, threadId: m.threadId, body: m.body, summary: m.summary ?? null, createdAt: m.createdAt,
    sender: ('kind' in m && m.kind==='steering') ? {id:m.actorProfileId,name:m.actorName,kind:'person' as const,
      photo: people.get(m.actorProfileId)?.photo ?? null, ...(people.get(m.actorProfileId)?.character ? { character: people.get(m.actorProfileId)!.character } : {}) } : { id: m.agentId, name: m.agentName, kind: 'agent' as const, ...agent(m.agentId) },
    audience: m.audience === 'project'
      ? { kind: 'project' as const }
      : { kind: 'direct' as const, to: m.to.map((id) => ({ id, name: names.get(id) ?? null, ...agent(id) })) },
  }));
}
// A message's [createdAt, id]. Firestore throws on an ID it cannot start after, so a bad one is refused here.
function messageCursor(value: unknown, scope: string): [number, string] | null {
  const decoded = cursorFrom(value, ['string', 'number', 'string']);
  const after = decoded?.slice(1) as [number, string] | null;
  if (decoded && (decoded[0] !== scope || !Number.isFinite(after![0]) || !/^[A-Za-z0-9_-]{1,200}$/.test(after![1]))) throw new Refusal('bad_input', 'That cursor is not one this page returned.');
  return after;
}

export function cursorFrom(value: unknown, types: string[]): unknown[] | null {
  if (value === undefined) return null;
  const after = typeof value === 'string' ? decodeCursor(value) : null;
  if (!after || after.length !== types.length || after.some((v, i) => typeof v !== types[i])) {
    throw new Refusal('bad_input', 'That cursor is not one this page returned.');
  }
  return after;
}
