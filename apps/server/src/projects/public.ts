import { isPrivateProject, isConvertedProject } from './schema.js';
import { runtimeWithCard } from './records.js';
import { DEFAULT_WORKSPACE_ID } from '../workspaces/schema.js';
import { projectExecution } from '@mlswarm/contracts';
// Published project projections are readable by invited accounts through projectManagementRoutes.
// these routes never grant membership, wake agents or make a private message public.
import express, { type Response } from 'express';
import { FieldPath, type DocumentSnapshot } from '../firestore.js';
import { Refusal, sendRefusal } from '../errors.js';
import { agents, db, inProject, projectDoc, currentProjectId, type Agent } from '../firestore.js';
import { readCanonicalAgentStates, readReadyCanonicalContacts } from '../view/communication-agents.js';
import { projects } from '../community/records.js';
import { cardDefinition, cardDoc, currentCard } from './card.js';
import { readCatalog } from './catalog.js';
import { validProjectId } from './access.js';
import { setupSnapshot, registeredParticipantCount, type WorkspaceProject } from './store.js';
import { messagesV2, type MessageV2 } from '../v2/records.js';
import { artworkOf } from './artwork.js';
import { communityRulesDoc } from './community-schema.js';
import { communityRulesView } from './community-rules.js';
import { searchAgentMessages } from './chat-search.js';
import { decodeCursor, encodeCursor } from '../cursor.js';

const encode = (scope: string, values: unknown[]) => encodeCursor([scope, ...values]);
function cursor(value: unknown, scope: string, types: ('string' | 'number')[]) {
  if (value === undefined) return null;
  try {
    if (typeof value !== 'string' || value.length > 500) throw new Error();
    const decoded: unknown = decodeCursor(value);
    if (!Array.isArray(decoded) || decoded.length !== types.length + 1 || decoded[0] !== scope) throw new Error();
    const values = decoded.slice(1);
    if (values.some((v, i) => types[i] === 'number' ? !Number.isSafeInteger(v) || Number(v) < 0 : typeof v !== 'string' || v.length > 200)) throw new Error();
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(String(values.at(-1)))) throw new Error();
    return values;
  } catch { throw new Refusal('bad_input', 'Use the cursor returned for this project and section.'); }
}
function documentId(raw: unknown) {
  if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(raw)) throw new Refusal('bad_input', 'Choose a project item.');
  return raw;
}
const shared = (m: MessageV2 | undefined): m is MessageV2 => !!m && m.audience === 'project' && m.to.length === 1 && m.to[0] === 'project';
const message = (m: MessageV2) => ({ id: m.id, threadId: m.threadId, body: m.body, summary: m.summary ?? null, createdAt: m.createdAt,
  sender: { id: m.agentId, name: m.agentName }, audience: { kind: 'project' } });
function runtime(p: WorkspaceProject | undefined) {
  return p ? { name: p.name, mission: p.mission, rules: p.rules, repoUrl: p.repoUrl, startsAt: p.startsAt,
    paused: p.paused, started: p.started,
    completedAt: p.completedAt ?? null, awaitingKickoff: p.awaitingKickoff ?? false } : null;
}

export function publicProjectRoutes(now: () => number) {
  const router = express.Router({ mergeParams: true });
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    // Unknown methods stay outside the public reader; authenticated mutation routes remain unchanged.
    if (req.method !== 'GET') { res.status(405).json({ error: 'method_not_allowed', message: 'Published project access is read-only.' }); return; }
    const id = req.params.id;
    if (!validProjectId(id)) { fail(res, new Refusal('not_found', 'This project isn’t published to Explore.')); return; }
    inProject(id, async () => {
      try {
        const catalog = await readCatalog({ project: id }, now);
        if (!catalog.projects[0]) throw new Refusal('not_found', 'This project isn’t published to Explore.');
        // An owner conversion discloses the Card and human chat, not private
        // agent conversation history. Fence every public history alias before
        // selecting messages, thread roots, search windows or pagination.
        if (/^\/(?:conversations|threads|messages)(?:\/|$)/i.test(req.path)) {
          const record = (await projects.doc(id).get()).data();
          if (!record || isConvertedProject(record)) throw new Refusal('not_found', 'These conversations are available only to project members.');
        }
        res.locals.catalog = catalog.projects[0];
        next();
      } catch (error) { fail(res, error); }
    });
  });
  const answer = (res: Response, work: () => Promise<unknown>) => void work().then(value => res.json(value), error => fail(res, error));
  router.get('/', (_req, res) => answer(res, async () => {
    const id = currentProjectId();
    const [approved, card, project, rules, agentCount] = await Promise.all([projects.doc(id).get(), cardDoc(id).get(), projectDoc().get(), communityRulesDoc(id).get(),
      agents().where('revokedAt', '==', null).count().get()]);
    if (!approved.exists || isPrivateProject(approved.data()) || !approved.data()!.publication.listed || approved.data()!.workspaceId !== DEFAULT_WORKSPACE_ID)
      throw new Refusal('not_found', 'This project isn’t published to Explore.');
    const p = runtimeWithCard(project.data(), card.data()), current = currentCard(approved.data()!, card.data()), safe = runtime(p), at = now();
    return { workspace: { id, listed: true, role: 'guest', publicationOrigin: isConvertedProject(approved.data()) ? 'owner_conversion' : 'reviewed_proposal', state: res.locals.catalog.state, ...artworkOf(approved.data()!.artwork, res.locals.catalog.coverImage), definition: cardDefinition(current.definition), cardVersion: current.version,
      communityRules: communityRulesView(rules.data()), project: safe, revision: p?.revision ?? 0,
      setup: setupSnapshot(approved.data()!, p), participantCount: await registeredParticipantCount(id, approved.data()!.ownerProfileId), execution: projectExecution(p), canConfigure: false },
      catalog: res.locals.catalog, overview: { project: safe, agentCount: agentCount.data().count, messageCount: null, generatedAt: at, serverTime: at } };
  }));
  async function agentRows(ids: string[]) {
    const [rows, contacts] = await Promise.all([ids.length ? db.getAll(...ids.map(id => agents().doc(id))) : [], readReadyCanonicalContacts(ids)]);
    // Contact/activity and derived status share a single admitted canonical snapshot.
    // No viewer is supplied: private Needs you is never queried for this public observation.
    const states = await readCanonicalAgentStates(rows as DocumentSnapshot<Agent>[], null, now(), contacts);
    return rows.map((doc, i) => {
      const a = doc.data()!, contact = contacts.docs[i]?.data();
      return { id: doc.id, name: a.name, operatorName: null, operatorId: null, createdAt: a.createdAt, revokedAt: a.revokedAt,
        // A status document holding only other groups (an agent that never ran) is no contact.
        v2Contact: contact?.lastContactAt !== undefined ? { lastContactAt: contact.lastContactAt, phase: contact.phase, phaseAt: contact.phaseAt } : null,
        activity: null, usage: null, state: states[i].state, freshUntil: states[i].freshUntil };
    });
  }
  router.get('/agents', (req, res) => answer(res, async () => {
    const q = req.query.q ?? '';
    if (typeof q !== 'string' || q.length > 40) throw new Refusal('bad_input', 'Search by up to 40 characters.');
    const scope = `public-agents:${currentProjectId()}:${q}`, after = cursor(req.query.cursor, scope, ['string', 'string']);
    const active = agents().where('revokedAt', '==', null);
    let query = (q ? active.where('name', '>=', q).where('name', '<=', q + '\uf8ff') : active).orderBy('name').orderBy(FieldPath.documentId()).limit(21);
    if (after) query = query.startAfter(...after);
    const found = await query.get(), rows = found.docs.slice(0, 20), last = rows.at(-1);
    return { agents: await agentRows(rows.map(d => d.id)), next: found.size > 20 && last ? encode(scope, [last.data().name, last.id]) : null, serverTime: now() };
  }));
  router.get('/agents/:agentId', (req, res) => answer(res, async () => {
    const id = documentId(req.params.agentId), doc = await agents().doc(id).get();
    if (!doc.exists) throw new Refusal('not_found', 'No agent in this project has that ID.');
    return { agent: (await agentRows([id]))[0], serverTime: now() };
  }));
  router.get('/conversations', (req, res) => answer(res, async () => {
    const scope = `public-conversations:${currentProjectId()}`, after = cursor(req.query.cursor, scope, ['number', 'string']);
    let query = messagesV2().where('audience', '==', 'project').orderBy('createdAt', 'desc').orderBy(FieldPath.documentId(), 'desc').limit(201);
    if (after) query = query.startAfter(...after);
    const found = await query.get(), scanned = found.docs.slice(0, 200), latest = new Map<string, MessageV2>();
    const candidates = scanned.filter(d => shared(d.data()));
    const ids = [...new Set(candidates.map(d => d.data().threadId))];
    const roots = ids.length ? await db.getAll(...ids.map(id => messagesV2().doc(documentId(id)))) : [];
    const publicRoots = new Map(roots.filter(d => shared(d.data() as MessageV2 | undefined)).map(d => [d.id, d.data()! as MessageV2]));
    let last = scanned.at(-1), filled = false;
    for (const d of scanned) {
      const m = d.data();
      if (shared(m) && publicRoots.has(m.threadId) && !latest.has(m.threadId)) {
        // A thread belongs only to the page containing its newest public message.
        if (after) {
          const newer = await messagesV2().where('threadId', '==', m.threadId).where('audience', '==', 'project').orderBy('createdAt', 'desc').orderBy(FieldPath.documentId(), 'desc').endAt(...after).limit(1).get();
          if (newer.docs.some(row => shared(row.data()))) continue;
        }
        if (latest.size === 20) { filled = true; break; }
        latest.set(m.threadId, m);
      }
      last = d;
    }
    const rows = await Promise.all([...latest].map(async ([id, m]) => ({ threadId: id,
      count: (await messagesV2().where('threadId', '==', id).where('audience', '==', 'project').count().get()).data().count,
      first: message(publicRoots.get(id)!), latest: message(m) })));
    return { conversations: rows, next: (filled || found.size > 200) && last ? encode(scope, [last.data().createdAt, last.id]) : null, serverTime: now() };
  }));
  router.get('/messages/:messageId', (req, res) => answer(res, async () => {
    const row = (await messagesV2().doc(documentId(req.params.messageId)).get()).data();
    if (!shared(row)) throw new Refusal('not_found', 'No public message has that ID.');
    const root = (await messagesV2().doc(documentId(row.threadId)).get()).data();
    if (!shared(root)) throw new Refusal('not_found', 'No public message has that ID.');
    return { message: message(row), serverTime: now() };
  }));
  router.get(['/threads/:threadId/search', '/conversations/search'], (req, res) => answer(res, async () => {
    let threadId: string | undefined;
    if (req.params.threadId) {
      const target = (await messagesV2().doc(documentId(req.params.threadId)).get()).data();
      if (!shared(target)) throw new Refusal('not_found', 'No public conversation has that ID.');
      const root = (await messagesV2().doc(documentId(target.threadId)).get()).data();
      if (!shared(root)) throw new Refusal('not_found', 'No public conversation has that ID.');
      threadId = target.threadId;
    }
    const result = await searchAgentMessages({ q: req.query.q, cursor: req.query.cursor, threadId, publicOnly: true });
    return { ...result, threadId: threadId ?? null, messages: result.messages.map(message), serverTime: now() };
  }));
  router.get('/threads/:threadId', (req, res) => answer(res, async () => {
    const target = (await messagesV2().doc(documentId(req.params.threadId)).get()).data();
    if (!shared(target)) throw new Refusal('not_found', 'No public conversation has that ID.');
    const root = (await messagesV2().doc(documentId(target.threadId)).get()).data();
    if (!shared(root)) throw new Refusal('not_found', 'No public conversation has that ID.');
    if (req.query.order !== undefined && req.query.order !== 'oldest' && req.query.order !== 'latest') throw new Refusal('bad_input', 'Choose oldest or latest thread history.');
    const latest = req.query.order === 'latest', direction = latest ? 'desc' : 'asc';
    const scope = `public-thread:${currentProjectId()}:${target.threadId}${latest ? ':latest' : ''}`, after = cursor(req.query.cursor, scope, ['number', 'string']);
    let query = messagesV2().where('threadId', '==', target.threadId).where('audience', '==', 'project').orderBy('createdAt', direction).orderBy(FieldPath.documentId(), direction).limit(201);
    if (after) query = query.startAfter(...after);
    const found = await query.get(), scanned = found.docs.slice(0, 200), rows: MessageV2[] = [];
    let last = scanned.at(-1), filled = false;
    for (const doc of scanned) {
      if (shared(doc.data())) { if (rows.length === 50) { filled = true; break; } rows.push(doc.data()); }
      last = doc;
    }
    const total = await messagesV2().where('threadId', '==', target.threadId).where('audience', '==', 'project').count().get();
    return { threadId: target.threadId, count: total.data().count, messages: (latest ? [...rows].reverse() : rows).map(message),
      next: (filled || found.size > 200) && last ? encode(scope, [last.data().createdAt, last.id]) : null, serverTime: now() };
  }));
  router.use((_req, res) => { res.status(404).json({ error: 'not_found', message: 'No public project section has that address.' }); });
  return router;
}
function fail(res: Response, error: unknown) {
  if (error instanceof Refusal) sendRefusal(res, error);
  else { console.error('A published project read failed.', error); res.status(500).json({ error: 'internal_error', message: 'Something went wrong loading this project. Try again in a moment.' }); }
}
