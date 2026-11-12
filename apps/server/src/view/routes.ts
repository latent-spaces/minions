import { projectContext } from '../analytics/context.js';
import { readProjectAnalytics } from '../analytics/read.js';
import { conversationOwner, conversationSource } from './conversation-source.js';
import { conversationEntries } from '../projects/steering.js';
import { publicProfilePhoto, publicPersonAppearance } from '../community/profile-photo-ref.js';
import { cursorFrom, present, readConversations, readThread } from './conversations.js';
import { readRuntime } from '../projects/records.js';
// Read-only endpoints for the rehearsal viewer,
// under /api/view. An invited person signs in with GitHub; the browser sends the Firebase ID token.
// Every read is a bounded page. Nothing here writes: no inbox is acknowledged, no cursor moves and
// no agent is woken.
import { FieldPath, type DocumentSnapshot } from '../firestore.js';
import express, { type Response, type Router } from 'express';
import { personaChoice } from '@mlswarm/contracts';
import { personFromIdToken, SIGN_IN_REQUIRED } from '../auth.js';
import { bearerToken } from '../bearer.js';
import { Refusal, sendRefusal } from '../errors.js';
import { requestLimits, sharedRead } from '../request-state.js';
import { assertMembership, projectRole } from '../projects/access.js';
import { projects } from '../community/records.js';
import { agents, currentProjectId, projectCollection, db, profiles, type Agent, type Profile } from '../firestore.js';
import { nativeTasks } from '../projects/native-tasks.js';
import { encodeCursor } from '../cursor.js';
import { runnerUsage } from '../v2/records.js';
import { searchConversationMessages } from '../projects/chat-search.js';
import { communicationTimeline, communicationWindow, communicationTraffic } from './communication.js';
import { readCurrentState } from './current-state.js';
import { communicationRoster } from './communication-roster.js';
import { communicationAgents, readCanonicalAgentStates, readReadyCanonicalContacts } from './communication-agents.js';
import { communicationEvents } from './communication-events.js';
import { readProjectUsage } from './project-usage.js';
import { projectQueuedStarts } from '../owner/web-agent-starts.js';
import { readRepositorySummary } from './repository-summary.js';

const AGENTS_PAGE = 20;
const LABEL_IDS = 60;
const OWNED_PAGE = 20;
const REQUESTS_PER_MINUTE = 60;
const OVERVIEW_TTL_MS = 10_000;
// Usage pages every agent's totals, so viewers on one replica share one scan per window.

// The live map polls every 5 s. Viewers of one project in one process share the newest frame for that long, and
// the traffic pages read for a shared frame time (a few cursors each), so open map tabs cost one scan each.
const LIVE_FRAME_TTL_MS = 5_000;
const TRAFFIC_TTL_MS = 10_000;
const TRAFFIC_PAGES = 32;


export function viewRoutes(now: () => number): Router {
  const router = express.Router();
  const admission = requestLimits.limiter(() => `viewer:${currentProjectId()}`, REQUESTS_PER_MINUTE, 60_000);
  // Only shared project observations are cached. Authentication and removal checks below
  // still run on every request; private account/connection data never enter this cache.
  let overview: Awaited<ReturnType<typeof readOverview>> | undefined;
  let refreshing: Promise<Awaited<ReturnType<typeof readOverview>>> | undefined;

  async function readOverview() {
    const generatedAt = now();
    const [project, agentCount, queued] = await Promise.all([
      readRuntime(), agents().where('revokedAt', '==', null).count().get(), projectQueuedStarts(currentProjectId(), generatedAt),
    ]);
    // No screen shows a message total, and counting every retained message costs one read per
    // 1,000 messages on each refresh; null, as the public overview already returns.
    return {
      project: project ?? null, agentCount: agentCount.data().count + queued.length, messageCount: null, generatedAt,
      repositorySummary: project ? await readRepositorySummary(project.repoUrl, generatedAt) : null,
    };
  }

  async function sharedOverview() {
    const age = overview ? now() - overview.generatedAt : Infinity;
    if (overview && age >= 0 && age < OVERVIEW_TTL_MS) return overview;
    // Concurrent viewers on this replica share one read. Failed refreshes are retryable;
    // never serve an expired summary as if it were a fresh successful observation.
    if (!refreshing) {
      refreshing = readOverview().then(value => { overview = value; return value; })
        .finally(() => { refreshing = undefined; });
    }
    return refreshing;
  }

  // Usage obtains its own post-request progress proof; never bypass it with a TTL/pending response cache.

  router.use(async (req, res, next) => {
    try {
      const token = bearerToken(req.headers.authorization);
      if (!token) throw new Refusal('unauthorized', SIGN_IN_REQUIRED);
      const person = await personFromIdToken(token);
      res.locals.projectRole = await projectRole(person);
      const at = now();
      const retry = admission(person.id, at);
      if (retry > 0) throw new Refusal('rate_limited', 'Too many requests. Wait a moment, then try again.', Math.ceil(retry / 1000));
      res.locals.ownerProfileId = person.id;
      next();
    } catch (error) {
      fail(res, error);
    }
  });

  router.get('/overview', (_req, res) => answer(res, async () => ({
    ...await sharedOverview(), serverTime: now(),
  })));

  router.get('/communication/timeline', (_req, res) => answer(res, async () => communicationTimeline(now())));
  router.get('/usage/context-runs', (req,res)=>answer(res,()=>projectContext(res.locals.ownerProfileId,req.query,'runs')));
  router.get('/usage/context-turns', (req,res)=>answer(res,()=>projectContext(res.locals.ownerProfileId,req.query,'turns')));
  router.get('/usage/context-now', (req,res)=>answer(res,()=>projectContext(res.locals.ownerProfileId,req.query,'now')));
  router.get('/usage/analytics', (req, res) => answer(res, async () => readProjectAnalytics(res.locals.ownerProfileId, req.query, now)));
  router.get('/usage', (_req, res) => answer(res, async () => ({ ...await readProjectUsage(now), serverTime: now() })));
  // Each answer still carries this request's server time; only the project-shared observation is reused.
  const trafficPages = new Map<string, () => ReturnType<typeof communicationTraffic>>();
  const sharedTraffic = (at: string, cursor: string | undefined) => {
    const key = JSON.stringify([at, cursor ?? null]);
    let read = trafficPages.get(key);
    if (!read) {
      if (trafficPages.size >= TRAFFIC_PAGES) trafficPages.delete(trafficPages.keys().next().value!);
      read = sharedRead(() => communicationTraffic(cursor === undefined ? { at } : { at, cursor }, now()), now, TRAFFIC_TTL_MS);
      trafficPages.set(key, read);
    }
    return read();
  };
  router.get('/communication/traffic', (req, res) => answer(res, async () => {
    const { at, cursor } = req.query;
    // Only a past frame time can be shared: a page for a time still to come is not yet complete.
    if (Object.keys(req.query).some(k => k !== 'at' && k !== 'cursor') || typeof at !== 'string' || !/^\d{1,16}$/.test(at) || Number(at) >= now()
      || (cursor !== undefined && typeof cursor !== 'string')) return communicationTraffic(req.query, now());
    return { ...await sharedTraffic(at, cursor), serverTime: now() };
  }));
  router.get('/communication/roster', (req, res) => answer(res, () => communicationRoster(req.query, now())));
  router.get('/communication/agents', (req, res) => answer(res, () => communicationAgents(req.query, res.locals.ownerProfileId, now())));
  // CS2b, the map's one status read (card v19: the status feed is removed, no kill switch): every agent once, then changes
  // since a cursor any process serves.
  router.get('/communication/agents/current', (req, res) => answer(res, () => {
    if (Object.keys(req.query).some(key => key !== 'cursor')) throw new Refusal('bad_input', 'Use a cursor this status read returned.');
    return readCurrentState(res.locals.ownerProfileId, res.locals.projectRole === 'owner', req.query.cursor, now());
  }));
  router.get('/communication/events', (req, res) => answer(res, () => communicationEvents(req.query, res.locals.ownerProfileId, now())));
  const presentedWindow = async (query: Record<string, unknown>) => {
    const result = await communicationWindow(query, now());
    return { ...result, messages: await present(result.messages) };
  };
  // trafficMark names the newest row of the frame's shared traffic (what every member's map shows, people's steering
  // included), so a map whose window gained nothing since its last traffic read can keep those rows.
  const liveFrame = sharedRead(async () => {
    const frame = await presentedWindow({ range: 'recent' });
    // The mark comes from the same cached first page the viewers' traffic read for this frame time returns, so page one
    // is read once per frame. Like the shared frame itself, it can miss a record stamped exactly at the frame time.
    const newest = (await sharedTraffic(String(frame.at), undefined)).traffic[0];
    return { ...frame, trafficMark: newest ? `${newest.createdAt}:${newest.id}` : null };
  }, now, LIVE_FRAME_TTL_MS);
  router.get('/communication', (req, res) => answer(res, async () => {
    const keys = Object.keys(req.query);
    const live = keys.length === 0 || (keys.length === 1 && req.query.range === 'recent');
    return live ? { ...await liveFrame(), serverTime: now() } : presentedWindow(req.query);
  }));

  // Participant-safe roster: profile identity only, never owner-management emails.
  router.get('/members', (req, res) => answer(res, async () => {
    if (req.query.ids !== undefined) return { members: await membersById(labelIds(req.query, 'members')), serverTime: now() };
    const scope = `member-roster:${currentProjectId()}`;
    const after = cursorFrom(req.query.cursor, ['string', 'string']);
    if (after && (after[0] !== scope || !/^[A-Za-z0-9_-]{1,200}$/.test(after[1] as string)))
      throw new Refusal('bad_input', 'Use this project’s members pagination.');
    const project = await projects.doc(currentProjectId()).get();
    const ownerId = project.data()!.ownerProfileId;
    let query = projectCollection('members').where('status', '==', 'active').orderBy(FieldPath.documentId()).limit(21);
    if (after) query = query.startAfter(after[1]);
    const found = await query.get(), page = found.docs.slice(0, 20);
    const ids = [...new Set([...(after ? [] : [ownerId]), ...page.filter(d => d.id !== ownerId
      && d.get('profileId') === d.id && d.get('projectId') === currentProjectId()).map(d => d.id)])];
    const last = page.at(-1);
    return { members: await rosterPeople(ids, ownerId),
      next: found.size > 20 && last ? encodeCursor([scope, last.id]) : null, serverTime: now() };
  }));

  // Active agents in name order; retired identities remain available by direct link. `q` keeps names starting with it (case-sensitive).
  router.get('/agents', (req, res) => answer(res, async () => {
    // `view=labels` answers only what labels an agent (name, owner, persona choice), without its live status, contact
    // or usage: the Tasks tab walks every page for labels, and a full row costs ≈7 reads more per agent.
    const { view, ...params } = req.query;
    if (view !== undefined && view !== 'labels') throw new Refusal('bad_input', 'Ask for the labels view or leave it out.');
    const rows = (docs: DocumentSnapshot<Agent>[]) => view === 'labels' ? agentLabels(docs) : agentRows(docs, res.locals.ownerProfileId, now());
    // Labels for ids already referenced elsewhere (task assignees, contributors, authors), as /agents/:id would
    // answer each one, retired agents included. Unknown ids are left out; there is no cursor.
    if (params.ids !== undefined) {
      const found = (await db.getAll(...labelIds(params, 'agents').map(id => agents().doc(id)))).filter(d => d.exists) as DocumentSnapshot<Agent>[];
      return { agents: await rows(found), next: null, serverTime: now() };
    }
    const q = params.q ?? '';
    if (typeof q !== 'string' || q.length > 40) throw new Refusal('bad_input', 'Search by up to 40 characters of a name.');
    const active = agents().where('revokedAt', '==', null);
    const named = q ? active.where('name', '>=', q).where('name', '<=', q + '\uf8ff') : active;
    // One extra row says whether another page exists, so a full last page offers no empty next page.
    let query = named.orderBy('name').orderBy(FieldPath.documentId()).limit(AGENTS_PAGE + 1);
    const after = cursorFrom(params.cursor, ['string', 'string', 'string']);
    if (after) {
      // Firestore throws on an ID it cannot start after, so a bad one is refused here.
      if (after[2] !== q || !/^[A-Za-z0-9_-]{1,200}$/.test(after[1] as string)) throw new Refusal('bad_input', 'That cursor is not one this page returned.');
      query = query.startAfter(after[0], after[1]);
    }
    const page = await query.get();
    const docs = page.docs.slice(0, AGENTS_PAGE);
    const last = docs.at(-1);
    // Agents waiting for an offline computer to create them come first on the first page, as Waiting.
    const queued = after || q ? [] : await queuedRows(now());
    return {
      agents: [...queued, ...await rows(docs)],
      next: page.size > AGENTS_PAGE && last ? encodeCursor([last.data().name, last.id, q]) : null,
      serverTime: now(),
    };
  }));

  // One agent, shaped as in the list.
  router.get('/agents/:id', (req, res) => answer(res, async () => {
    const id = String(req.params.id);
    const doc = /^[A-Za-z0-9_-]{1,200}$/.test(id) ? await agents().doc(id).get() : undefined;
    if (!doc?.exists) throw new Refusal('not_found', `There is no agent ${id}.`);
    return { agent: (await agentRows([doc], res.locals.ownerProfileId, now()))[0], serverTime: now() };
  }));

  // Native responsibility survives worker restarts and remains separate from runtime status.
  // Only this person's own agent is available through this personal panel.
  router.get('/agents/:id/responsibilities', (req, res) => answer(res, () => db.runTransaction(async tx => {
    const id = String(req.params.id);
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw new Refusal('not_found', 'This agent is unavailable.');
    await assertMembership(tx, res.locals.ownerProfileId);
    const doc = await tx.get(agents().doc(id));
    if (!doc.exists || doc.data()!.ownerProfileId !== res.locals.ownerProfileId) throw new Refusal('not_found', 'This agent is unavailable.');
    let query = nativeTasks().where('assignedAgentId', '==', id).orderBy(FieldPath.documentId()).limit(OWNED_PAGE + 1);
    const scope = `native-tasks:${currentProjectId()}:${id}`;
    const after = cursorFrom(req.query.cursor, ['string', 'string']);
    if (after) {
      if (after[0] !== scope || !/^[A-Za-z0-9_-]{1,200}$/.test(after[1] as string)) throw new Refusal('bad_input', 'Use this agent’s task pagination.');
      query = query.startAfter(after[1]);
    }
    const page = await tx.get(query), docs = page.docs.slice(0, OWNED_PAGE), last = docs.at(-1);
    return {
      tasks: docs.map(row => { const task = row.data(); return { id: task.id, title: task.title, status: task.status, revision: task.revision, updatedAt: task.updatedAt }; }),
      next: page.size > OWNED_PAGE && last ? encodeCursor([scope, last.id]) : null,
      serverTime: now(),
    };
  })));

  router.get('/messages/:id', (req, res) => answer(res, async () => {
    const id = String(req.params.id);
    const row = /^[A-Za-z0-9_-]{1,200}$/.test(id) ? (await conversationEntries().doc(id).get()).data() : undefined;
    const owner = conversationOwner(req.query.authors, res.locals.ownerProfileId);
    if (!row || owner && !(await conversationSource(owner)).matches(row)) throw new Refusal('not_found', 'This message is unavailable.');
    return { message: (await present([row]))[0], serverTime: now() };
  }));

  router.get(['/threads/:id/search', '/conversations/search'], (req, res) => answer(res, async () => {
    let threadId: string | undefined;
    if (req.params.id) {
      const id = String(req.params.id);
      const target = /^[A-Za-z0-9_-]{1,200}$/.test(id) ? (await conversationEntries().doc(id).get()).data() : undefined;
      if (!target) throw new Refusal('not_found', 'This conversation is unavailable.');
      threadId = target.threadId;
    }
    const result = await searchConversationMessages({ q: req.query.q, cursor: req.query.cursor, threadId, profileId: conversationOwner(req.query.authors, res.locals.ownerProfileId) });
    return { ...result, threadId: threadId ?? null, messages: await present(result.messages), serverTime: now() };
  }));

  // Member history is newest-first on the wire, displayed chronologically.
  router.get('/threads/:id', (req, res) => answer(res, () => readThread(String(req.params.id), req.query, now, conversationOwner(req.query.authors, res.locals.ownerProfileId))));
  router.get('/conversations', (req, res) => answer(res, () => readConversations(req.query.cursor, now, conversationOwner(req.query.authors, res.locals.ownerProfileId))));


  return router;
}

// The viewer's row for each agent doc, with owner, contact and usage reads batched.
async function queuedRows(at: number) {
  const rows = await projectQueuedStarts(currentProjectId(), at);
  const owners = await peopleOf([...new Set(rows.map(r => r.profileId))]);
  return rows.map(r => ({ id: r.id, name: r.name, operatorName: owners.get(r.profileId)?.name ?? null, operatorPhoto: owners.get(r.profileId)?.photo ?? null,
    operatorId: owners.has(r.profileId) ? r.profileId : null, createdAt: r.createdAt, revokedAt: null, focus: null, v2Contact: null, activity: null, usage: null,
    personaChoice: null, state: 'waiting' as const, freshUntil: null }));
}
// Labels include provider identity from usage; no presence, run, session or status resolution.
async function agentLabels(docs: DocumentSnapshot<Agent>[]) {
  const [owners, usage] = await Promise.all([peopleOf([...new Set(docs.map(d => d.data()!.ownerProfileId))]), docs.length ? db.getAll(...docs.map(d => runnerUsage().doc(d.id))) : []]);
  return docs.map((d, index) => {
    const agent = d.data()!, owner = owners.get(agent.ownerProfileId);
    return { id: d.id, name: agent.name, ...(usage[index]?.get('provider') ? { provider: usage[index].get('provider') } : {}), operatorName: owner?.name ?? null, operatorPhoto: owner?.photo ?? null,
      operatorId: owner ? agent.ownerProfileId : null, createdAt: agent.createdAt, revokedAt: agent.revokedAt,
      personaChoice: personaChoice(agent.persona?.text ?? '') };
  });
}
async function agentRows(docs: DocumentSnapshot<Agent>[], profileId: string, at: number) {
  const ids = docs.map((d) => d.id);
  // Read canonical contacts behind admission once, then share that snapshot between
  // raw contact/activity and derived status. Historical incomplete rows retain identity.
  const [owners, seen, usage] = await Promise.all([
    peopleOf([...new Set(docs.map((d) => d.data()!.ownerProfileId))]),
    readReadyCanonicalContacts(ids),
    ids.length === 0 ? [] : db.getAll(...ids.map((id) => runnerUsage().doc(id))),
  ]);
  const states = await readCanonicalAgentStates(docs, profileId, at, seen);
  return docs.map((d, i) => {
    const agent = d.data()!;
    const v2 = seen.docs[i]?.data();
    return {
      id: d.id, name: agent.name, operatorName: owners.get(agent.ownerProfileId)?.name ?? null,
      operatorPhoto: owners.get(agent.ownerProfileId)?.photo ?? null,
      operatorId: owners.has(agent.ownerProfileId) ? agent.ownerProfileId : null,
      createdAt: agent.createdAt, revokedAt: agent.revokedAt,
      focus: agent.focus ? { text: agent.focus.text, updatedAt: agent.focus.updatedAt } : null,
      // Contact and activity are separate observations. Neither says what the agent is working on.
      // A status document holding only other groups (an agent that never ran) is no contact.
      v2Contact: v2?.lastContactAt !== undefined ? { lastContactAt: v2.lastContactAt, phase: v2.phase, phaseAt: v2.phaseAt } : null,
      activity: v2?.activity ?? null,
      usage: usage[i]?.data() ? { ...usage[i].data(), runId: undefined, aggregated: undefined } : null,
      personaChoice: states[i].personaChoice, state: states[i].state, freshUntil: states[i].freshUntil,
    };
  });
}

// One screen of labels: up to 60 different ids, and no other query, so a lookup never pages or filters.
function labelIds(query: Record<string, unknown>, kind: 'agents' | 'members'): string[] {
  const ids = typeof query.ids === 'string' ? query.ids.split(',') : [];
  if (Object.keys(query).some(key => key !== 'ids') || !ids.length || ids.length > LABEL_IDS
    || new Set(ids).size !== ids.length || ids.some(id => !/^[A-Za-z0-9_-]{1,200}$/.test(id)))
    throw new Refusal('bad_input', `Choose up to ${LABEL_IDS} different ${kind} from this project.`);
  return ids;
}

// The same people the roster pages list: the owner and active members whose profile is not removed.
async function membersById(ids: string[]) {
  const project = await projects.doc(currentProjectId()).get();
  const ownerId = project.data()!.ownerProfileId;
  const rows = await db.getAll(...ids.map(id => projectCollection('members').doc(id)));
  const listed = ids.filter((id, i) => id === ownerId || (rows[i].get('status') === 'active'
    && rows[i].get('profileId') === id && rows[i].get('projectId') === currentProjectId()));
  return rosterPeople(listed, ownerId);
}

async function rosterPeople(ids: string[], ownerId: string) {
  const persons = ids.length ? await db.getAll(...ids.map(id => profiles.doc(id))) : [];
  return persons.filter(d => d.exists && d.get('removedAt') === null)
    .map(d => ({ id: d.id, owner: d.id === ownerId, name: d.get('name'), ...publicPersonAppearance(d.data()! as Profile, d.id) }));
}

async function peopleOf(personIds: string[]): Promise<Map<string, { name: string; photo: ReturnType<typeof publicProfilePhoto>; character?: import('@mlswarm/contracts').PersonCharacter | null }>> {
  if (personIds.length === 0) return new Map();
  const docs = await db.getAll(...personIds.map((id) => profiles.doc(id)));
  return new Map(docs.filter((d) => d.exists).map((d) => [d.id, { name: d.data()!.name, ...publicPersonAppearance(d.data()! as Profile, d.id) }]));
}

async function answer(res: Response, handle: () => Promise<object>): Promise<void> {
  try {
    res.set('Cache-Control', 'no-store').json(await handle());
  } catch (error) {
    fail(res, error);
  }
}

function fail(res: Response, error: unknown): void {
  if (error instanceof Refusal) { sendRefusal(res, error); return; }
  console.error('A viewer request failed.', error);
  if (!res.headersSent) res.status(500).json({ error: 'internal_error', message: 'Something went wrong on MyLittleSwarm. Try again in a moment.' });
}
