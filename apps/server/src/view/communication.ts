import { conversationEntries, type ConversationEntry } from '../projects/steering.js';
import { FieldPath } from '../firestore.js';
import { currentProjectId, projectDoc } from '../firestore.js';
import { Refusal } from '../errors.js';
import { messagesV2, type MessageV2 } from '../v2/records.js';
import { decodeCursor, encodeCursor } from '../cursor.js';

const PAGE = 500;
const BUCKETS = 32;
type Timeline = { start: number; end: number; buckets: number[]; observedAt: number; closed: boolean; origin: string };
const timelines = new Map<string, { expires: number; value: Promise<Timeline> }>();

// Shared, bounded metadata cache. Authorization runs in viewRoutes before every read.
export function communicationTimeline(now: number): Promise<Timeline> {
  const id = currentProjectId(), existing = timelines.get(id);
  if (existing && existing.expires > now) return existing.value;
  if (timelines.size >= 100) timelines.delete(timelines.keys().next().value!);
  const value = (async () => {
    const [project, first] = await Promise.all([projectDoc().get(), messagesV2().orderBy('createdAt').limit(1).get()]);
    const execution = project.data()?.execution;
    const firstAt = first.docs[0]?.data().createdAt;
    const kickoff = execution?.started ? execution.startsAt : undefined;
    const start = Math.min(now, execution?.completedAt ?? now, kickoff ?? firstAt ?? now, firstAt ?? now);
    const end = Math.max(start, Math.min(now, execution?.completedAt ?? now));
    const span = Math.max(1, end - start + 1);
    const boundaries = Array.from({ length: BUCKETS + 1 }, (_, i) => start + Math.floor(span * i / BUCKETS));
    const buckets = await Promise.all(boundaries.slice(0, -1).map(async (from, i) => {
      if (from === boundaries[i + 1]) return 0;
      return (await messagesV2().where('createdAt', '>=', from).where('createdAt', '<', boundaries[i + 1]).count().get()).data().count;
    }));
    return { start, end, buckets, observedAt: now, closed: execution?.completedAt != null, origin: kickoff !== undefined && (firstAt === undefined || kickoff <= firstAt) ? 'Project start' : 'First activity' };
  })();
  timelines.set(id, { expires: now + 30_000, value });
  value.catch(() => { if (timelines.get(id)?.value === value) timelines.delete(id); });
  return value;
}

async function communicationPage(query: Record<string, unknown>, now: number, shared = false) {
  if (Object.keys(query).some(k => !['at', 'range', 'cursor'].includes(k))) throw new Refusal('bad_input', 'Choose a replay time and recent or all connections.');
  const at = query.at === undefined ? now : typeof query.at === 'string' && /^\d{1,16}$/.test(query.at) ? Number(query.at) : NaN;
  const range = query.range ?? 'recent';
  if (!Number.isSafeInteger(at) || at < 0 || at > now || !['recent', 'all'].includes(range as string)) throw new Refusal('bad_input', 'Choose an available replay time and recent or all connections.');
  const from = range === 'recent' ? Math.max(0, at - 300_000) : 0;
  const scope = shared ? `shared-${range}` : range;
  let cursor: unknown[] | null = null;
  if (query.cursor !== undefined) {
    cursor = typeof query.cursor === 'string' ? decodeCursor(query.cursor) : null;
    if (!cursor || cursor.length !== 5 || cursor[0] !== currentProjectId() || cursor[1] !== at || cursor[2] !== scope
      || !Number.isSafeInteger(cursor[3]) || (cursor[3] as number) < from || (cursor[3] as number) > at
      || typeof cursor[4] !== 'string' || !/^[\w-]{1,200}$/.test(cursor[4])) throw new Refusal('bad_input', 'Use this communication window’s pagination.');
  }
  const records = shared ? conversationEntries() : messagesV2();
  let scan = records.where('createdAt', '>=', from).where('createdAt', '<=', at)
    .orderBy('createdAt', 'desc').orderBy(FieldPath.documentId(), 'desc').limit(PAGE + 1);
  if (cursor) scan = scan.startAfter(cursor[3], cursor[4]);
  // Bodies are read separately only for the newest 30 messages in this window.
  const found = await scan.select('agentId', 'agentName', 'to', 'audience', 'createdAt', ...(shared ? ['kind', 'actorProfileId'] : [])).get();
  const page = found.docs.slice(0, PAGE), last = page.at(-1);
  return { at, from, range, page, next: found.size > PAGE && last ? encodeCursor([currentProjectId(), at, scope, last.data().createdAt, last.id]) : null };
}

export async function communicationWindow(query: Record<string, unknown>, now: number) {
  const { at, from, range, page, next } = await communicationPage(query, now);
  const nodes = new Map<string, { id: string; name: string | null }>();
  const edges = new Map<string, { from: string; to: string; count: number; latestAt: number }>();
  for (const doc of page) {
    const m = doc.data() as MessageV2;
    nodes.set(m.agentId, { id: m.agentId, name: m.agentName });
    if (m.audience !== 'direct') continue;
    for (const recipient of m.to) {
      nodes.set(recipient, nodes.get(recipient) ?? { id: recipient, name: null });
      const key = JSON.stringify([m.agentId, recipient]), before = edges.get(key);
      edges.set(key, { from: m.agentId, to: recipient, count: (before?.count ?? 0) + 1, latestAt: Math.max(before?.latestAt ?? 0, m.createdAt) });
    }
  }
  const details = query.cursor !== undefined || !page.length ? [] : await messagesV2().firestore.getAll(...page.slice(0, 30).map(d => d.ref));
  return { at, from, range, nodes: [...nodes.values()], edges: [...edges.values()], scanned: page.length,
    messages: details.map(d => d.data() as MessageV2).reverse(),
    next, serverTime: now };
}

/** Member-visible, body-free graph input. Cursors remain bound to project/time/window. */
export async function communicationTraffic(query:Record<string,unknown>,now:number){
 if(Object.keys(query).some(k=>!['at','cursor'].includes(k)))throw new Refusal('bad_input','Choose a graph frame and its cursor.');
 const frame=await communicationPage({...query,range:'recent'},now,true);
 // Conversations is the existing shared record: agent messages are mirrored at
 // send time, steering is saved before delivery. Earlier private instructions are
 // deliberately not read. A person ID must match the map's existing person node.
 const traffic=frame.page.flatMap(doc=>{
  const m=doc.data() as ConversationEntry;
  if(m.kind!=='agent_message'&&m.kind!=='steering')return [];
  if(m.kind==='steering'&&(!m.actorProfileId||m.audience!=='direct'))return [];
  return [{id:doc.id,agentId:m.kind==='steering'?`person:${m.actorProfileId}`:m.agentId,to:m.to,audience:m.audience,createdAt:m.createdAt}];
 });
 return {at:frame.at,from:frame.from,traffic,next:frame.next,serverTime:now};
}
