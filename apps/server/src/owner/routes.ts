import { reportMergePolicy } from '../projects/merge-policy.js';
import { shortSharedLink } from '../shared-links.js';
import { FieldPath } from '../firestore.js';
import { computerConnections, currentComputer, COMPUTER_DISCONNECTED } from './computer-access.js';
import { deploymentKind } from '../deployment.js';
import { randomUUID } from 'node:crypto';
export { computerConnections } from './computer-access.js';
import { prepareOnboardingProgress } from '../onboarding/progress.js';
import { submitSteering, steeringResult } from '../projects/steering.js';
import {readNotifications,markNotificationRead,markAllNotificationsRead} from '../projects/moderation-notifications.js';
import { publishGitHubAccess } from '../projects/github-access.js';
import { repositoryAccess } from '../projects/github-username.js';
import { createWebAgentStart, readWebAgentStart, inspectAgentStart, cancelAgentStart, readAgentStartCancellation, publishRuntimeReadiness, readAgentStarts, acceptAgentStart, receiptAgentStart, runtimeReadiness, readinessView } from './web-agent-starts.js';
import { ANSWER_HUMAN, answerHumanRequest, readHumanRequests } from '../projects/human-requests.js';
import { boundedVerification } from '../verification-gate.js';
import { readProjectUpdateSettings, saveProjectUpdateSettings } from '../projects/progress-settings.js';

import { CARD_EDIT } from '../projects/card.js';
import { PUBLIC_CONVERSION, convertProjectToPublic, readPublicConversion } from '../projects/public-conversion.js';
import { deriveProjectLifecycle } from '@mlswarm/contracts';
// Replies keep the next step once, as nextStep, instead of three copies of the same text.
const withoutCopy = ({ help: _help, next: { description: _description, ...next }, ...state }: ReturnType<typeof deriveProjectLifecycle>) => ({ ...state, next });
import { registerAgentTeam } from '../onboarding/registration.js';
import { connectOwnAgent, connectOwnAgentInput } from './agents.js';
import { listMyWorkers } from '../projects/worker-sessions.js';
import { syncBackgrounds, readBackgroundCommands, acknowledgeBackgroundCommand } from '../projects/background-controls.js';
import { syncParticipations, readParticipationCommands, acceptParticipationCommand, acknowledgeParticipationCommand, requestParticipationControl } from '../projects/chat-controls.js';
import { saveWorkSettings, workSettingsInput } from '../onboarding/store.js';
import { saveAgentPersona } from '../projects/agent-participation.js';
import express, { type Request, type Response } from 'express';
import { localhostHostValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import { z } from 'zod';
import { SIGN_IN_REQUIRED, hashToken, personIdentityFromIdToken, signInFromIdToken, verifiedEmails } from '../auth.js';
import { identity } from '../identity/index.js';
import { bearerToken } from '../bearer.js';
import { approvedAdminSession } from '../admin-auth.js';
import { findAgents } from '../v2/agents.js';
import { readConversations, readThread } from '../view/conversations.js';
import { readHumanChat } from '../projects/chat.js';
import { readProgressUpdates } from '../projects/progress.js';
import { listNativeTasks, getNativeTask } from '../projects/native-tasks.js';
import { db, profiles, inProject, type Profile, type WithId } from '../firestore.js';
import { Refusal, sendRefusal } from '../errors.js';
import { requestLimits } from '../request-state.js';
import { listProposals, getProposal } from '../community/proposals.js';
import { CONFIGURE, FINALIZE, configureWorkspace, finalizeWorkspace, editCard, CONTROL, controlWorkspace, listMyProjects, listProjects, readWorkspace } from '../projects/store.js';
import { projectRole, validProjectId } from '../projects/access.js';
import { PERSONAL_ARCHIVE, setPersonalArchive } from '../projects/personal-archive.js';
import { CREATE_PRIVATE, createPrivateProject } from '../projects/private.js';

// One process-wide expensive-auth budget, also shared by computer-only hosting ingress.
export const ownerVerification = boundedVerification();
const secret = z.string().regex(/^[\w-]{43}$/), uuid = z.string().uuid();
const LOCAL_COMPUTER = z.object({ candidateTokenHash: z.string().regex(/^[a-f0-9]{64}$/), clientName: z.string().trim().min(1).max(100).refine(v => !/[\x00-\x1f\x7f]/.test(v)) }).strict();
const parse = <T>(schema: z.ZodType<T>, value: unknown): T => { const result = schema.safeParse(value); if (!result.success) throw new Refusal('bad_input', 'Some fields in this request are missing or not in the expected form.'); return result.data; };
// The connector recognizes this message and connects this computer again by itself.
const unavailable = () => new Refusal('unauthorized', COMPUTER_DISCONNECTED);

// The engine serves one owner on this computer (owner decision, 13 November 2026): the connector connects the computer
// with the owner's local session, with no approval step, and the connection does not expire. The candidate token's
// hash names the connection, so a retry after a lost reply answers with the same one.
async function connectLocalComputer(input: z.infer<typeof LOCAL_COMPUTER>, idToken: string, now: () => number, admit: (profileId: string) => void) {
  const signIn = await signInFromIdToken(idToken);
  const { person } = await personIdentityFromIdToken(idToken);
  admit(person.id);
  return db.runTransaction(async tx => {
    const found = await tx.get(computerConnections.where('candidateTokenHash', '==', input.candidateTokenHash).limit(2));
    const existing = found.size === 1 ? found.docs[0] : null, c = existing?.data();
    const reply = (id: string) => ({ connectionId: id, personId: person.id, personName: person.name, email: person.email });
    if (found.size > 1 || c && (!currentComputer(c, person.id) || c.firebaseUid !== signIn.firebaseUid)) throw new Refusal('duplicate', 'This computer credential is already in use. Connect again with a new one.');
    if (existing) return reply(existing.id);
    const active = (await tx.get(profiles.doc(person.id))).data(); if (!active || active.removedAt !== null) throw new Refusal('unauthorized', SIGN_IN_REQUIRED);
    const progress = await prepareOnboardingProgress(tx, person.id, now());
    const at = now(), id = randomUUID();
    tx.create(computerConnections.doc(id), { requestId: id, candidateTokenHash: input.candidateTokenHash, clientName: input.clientName, createdAt: at,
      approvedAt: at, revokedAt: null, profileId: person.id, firebaseUid: signIn.firebaseUid, authenticatedAt: signIn.authTime });
    progress(['computer']);
    return reply(id);
  });
}
export async function ownerFromToken(token: string, now: () => number): Promise<{ person: WithId<Profile>; connectionId: string; coFounder: boolean }> {
  if (!secret.safeParse(token).success) throw unavailable();
  const found = await computerConnections.where('candidateTokenHash', '==', hashToken(token)).limit(2).get();
  const doc = found.size === 1 ? found.docs[0] : null, c = doc?.data();
  if (!c || !c.profileId || !currentComputer(c, c.profileId) || !c.firebaseUid) throw unavailable();
  const [person, account] = await Promise.all([profiles.doc(c.profileId).get(), identity().account(c.firebaseUid).catch(() => null)]);
  if (!person.exists || person.data()!.removedAt !== null || !account || account.disabled || !(await verifiedEmails(account)).includes(person.data()!.email.toLowerCase()) || account.validAfter > c.authenticatedAt!) throw unavailable();
  // Records authenticated account API use, before any project-specific authorization.
  // This is an observation, not a heartbeat or proof that a computer/model is running.
  const at = now();
  // A newer concurrent observation also coalesces; never move the stored time backwards.
  const recentUse = (value: number | undefined) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && at - value < 5 * 60_000;
  if (!recentUse(c.lastUsedAt)) await db.runTransaction(async tx => {
    const current = (await tx.get(doc!.ref)).data();
    // Recheck the connection after the identity lookup; simultaneous requests coalesce to one write.
    if (!current || !currentComputer(current, c.profileId!)
      || current.firebaseUid !== c.firebaseUid || current.candidateTokenHash !== c.candidateTokenHash) throw unavailable();
    if (!recentUse(current.lastUsedAt)) tx.update(doc!.ref, { lastUsedAt: at });
  });
  // Co-founder authority follows the connecting sign-in the same way a website session does (auth.ts).
  return { person: { id: person.id, ...person.data()! }, connectionId: doc!.id, coFounder: approvedAdminSession({ provider: account.primaryProvider, email: person.data()!.email }) };
}
function projectStatus(id: string, w: Awaited<ReturnType<typeof readWorkspace>>) {
  const state = w.state;
  return { projectId: id, title: w.definition.title, revision: w.revision, state: withoutCopy(state), status: state.status, nextStep: state.next.description,
    participantCount: w.participantCount, minimumContributors: w.setup.minContributors, contributorsNeeded: state.contributorsNeeded,
    targetStartDate: w.setup.startDeadline, published: w.listed, blockers: state.readiness.blockers.map(b => b.reason),
    canStart: state.readiness.canStart, canStartWithFewer: state.readiness.canStartWithFewer, startsAgents: false };
}
function fail(res: Response, error: unknown) {
  if (error instanceof Refusal) sendRefusal(res, error);
  else { console.error('Owner request failed.', error); res.status(500).json({ error: 'internal_error', message: 'Something went wrong on MyLittleSwarm. Try again in a moment.' }); }
}
// Mounted before the SDK's default 100 KiB parser for this one bounded route.
// Preserve its Host-before-body protection when listening on loopback.
export function participationSnapshotParser(host: string) {
  const router = express.Router();
  if (['127.0.0.1', 'localhost', '::1'].includes(host)) router.use(localhostHostValidation());
  router.use(express.json({ limit: '300kb' }));
  return router;
}
export function ownerRoutes(now: () => number, { selfHosted = () => deploymentKind() === 'self-hosted' }: { selfHosted?: () => boolean } = {}) {
  const router = express.Router(); router.use(express.json({ limit: '300kb' }));
  router.use((req, res, next) => { const limit=['/participations/sync','/backgrounds/sync'].includes(req.path) ? 300*1024 : 16*1024;
    if (req.body !== undefined && Buffer.byteLength(JSON.stringify(req.body), 'utf8') > limit) { res.status(413).set('Cache-Control', 'no-store').json({ error: 'bad_input', message: 'This request is too large.' }); } else next(); });
  const verify = ownerVerification;
  const browserPerson = (req: Request) => verify(async () => (await personIdentityFromIdToken(bearerToken(req.headers.authorization) ?? '')).person);
  const personLimit = requestLimits.limiter(() => 'owner-person', 60, 60_000);
  const observationLimit = requestLimits.limiter(() => 'owner-observation',120,60_000);
  const deviceObservationLimit = requestLimits.limiter(() => 'owner-device-observation',30,60_000);
  const unverifiedLimit = requestLimits.limiter(() => 'owner-unverified', 60, 60_000);
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const admit = (limit: ReturnType<typeof requestLimits.limiter>, key: string) => {
    const retry = limit(key, now());
    if (retry > 0) throw new Refusal('rate_limited', 'Too many requests. Wait a moment, then try again.', Math.ceil(retry / 1000));
  };
  // Socket-based admission is deliberately coarse for unverified traffic. Never trust caller-chosen XFF.
  const unverified = (req: Request) => admit(unverifiedLimit, req.ip ?? 'unknown');
  const personAdmission = (profileId: string) => admit(personLimit, profileId);
  const observationAdmission = (profileId:string,connectionId?:string) => {
    admit(observationLimit,profileId);
    if(connectionId)admit(deviceObservationLimit,connectionId);
  };
  const answer = (res: Response, fn: () => Promise<unknown>) => void Promise.resolve().then(fn).then(v => res.json(v), e => fail(res, e));
  const requestId = (value: unknown) => parse(uuid, value);
  router.post('/local-computer', (req, res) => answer(res, async () => {
    if (!selfHosted()) { unverified(req); throw new Refusal('not_found', 'This MyLittleSwarm engine connects computers only when it runs on this computer.'); }
    const input = parse(LOCAL_COMPUTER, req.body);
    return verify(() => connectLocalComputer(input, bearerToken(req.headers.authorization) ?? '', now, personAdmission));
  }));
  // The owner's browser reads below have no budget: the one local owner's viewing is never refused.
  router.get('/notifications', (req,res)=>answer(res,async()=>{
    const person=await browserPerson(req);
    if(req.get('X-Mlswarm-Profile-Id')!==person.id)throw new Refusal('unauthorized','Your selected account changed.');
    return readNotifications(person.id,req.query);
  }));
  router.post('/notifications/read-all', (req,res)=>answer(res,async()=>{
    const person=await browserPerson(req);personAdmission(person.id);parse(z.object({}).strict(),req.body);
    if(req.get('X-Mlswarm-Profile-Id')!==person.id)throw new Refusal('unauthorized','Your selected account changed.');
    return markAllNotificationsRead(person.id,now);
  }));
  router.post('/notifications/:id/read', (req,res)=>answer(res,async()=>{
    const person=await browserPerson(req);personAdmission(person.id);parse(z.object({}).strict(),req.body);
    if(req.get('X-Mlswarm-Profile-Id')!==person.id)throw new Refusal('unauthorized','Your selected account changed.');
    return markNotificationRead(person.id,String(req.params.id),now);
  }));
  router.get('/profile', (req,res) => answer(res, async () => { const person=await browserPerson(req); return {profileId:person.id,name:person.name}; }));
  // The web app picks one of this person's computers to queue an agent start on.
  router.get('/computers', (req, res) => answer(res, async () => {
    const person = await browserPerson(req);
    const cursor = req.query.cursor === undefined ? null : requestId(req.query.cursor);
    let query = computerConnections.where('profileId', '==', person.id).orderBy(FieldPath.documentId()).limit(51);
    if (cursor) query = query.startAfter(cursor);
    const found = await query.get(), page = found.docs.slice(0, 50), at = now();
    const eligible = page.map(d => ({ ...d.data(), requestId: d.id })).filter(c => currentComputer(c, person.id));
    const readiness = new Map((await Promise.all(eligible.map(c => runtimeReadiness.doc(c.requestId).get()))).map(d => [d.id,d.data()]));
    return { next: found.size > 50 ? page.at(-1)!.id : null,
      computers: eligible.sort((a, b) => b.approvedAt! - a.approvedAt!).map(c => ({ id: c.requestId, clientName: c.clientName,
        approvedAt: c.approvedAt, runtime: readinessView(readiness.get(c.requestId), at) })) };
  }));
  router.post('/web-agent-starts',(req,res)=>answer(res,async()=>{
    const person=await browserPerson(req);personAdmission(person.id);
    if(req.get('X-Mlswarm-Profile-Id')!==person.id)throw new Refusal('unauthorized','This computer is now connected to a different MyLittleSwarm account. Check which account you meant, then try again.');
    return createWebAgentStart(person.id,req.body,now);
  }));
  router.get('/web-agent-starts/:id',(req,res)=>answer(res,async()=>{const person=await browserPerson(req);return readWebAgentStart(person.id,String(req.params.id),now);}));
  router.use(async (req, res, next) => {
    try {
      const session = await verify(() => ownerFromToken(bearerToken(req.headers.authorization) ?? '', now));
      // Presence and mailbox observations must not exhaust the human action budget.
      const observation = (req.method==='GET' && (req.path==='/agent-starts' || req.path==='/repository-access'))
        || (req.method==='POST' && (req.path==='/runtime/readiness'||req.path==='/repository-access/observations'||req.path==='/repository-access/merge-policy'));
      if(observation) observationAdmission(session.person.id,session.connectionId);
      else personAdmission(session.person.id);
      res.locals.owner=session.person;res.locals.connectionId=session.connectionId;res.locals.coFounder=session.coFounder;next();
    } catch (e) { fail(res,e); }
  });
  router.get('/repository-access',(req,res)=>answer(res,()=>{parse(z.object({}).strict(),req.query);return repositoryAccess(res.locals.owner.id);}));
  router.post('/repository-access/merge-policy',(req,res)=>answer(res,()=>reportMergePolicy(res.locals.owner.id,res.locals.connectionId,req.body,now)));
  router.post('/repository-access/observations',(req,res)=>answer(res,()=>publishGitHubAccess(res.locals.owner.id,res.locals.connectionId,req.body,now)));
  router.post('/runtime/readiness',(req,res)=>answer(res,()=>publishRuntimeReadiness(res.locals.owner.id,res.locals.connectionId,req.body,now)));
  router.get('/agent-starts',(req,res)=>answer(res,()=>readAgentStarts(res.locals.owner.id,res.locals.connectionId,req.query,now)));
  // A coding chat that adds an agent queues its run for this same computer.
  router.post('/agent-starts',(req,res)=>answer(res,()=>createWebAgentStart(res.locals.owner.id,{...(req.body&&typeof req.body==='object'?req.body:{}),connectionId:res.locals.connectionId},now)));
  router.get('/agent-start-controls/:id',(req,res)=>answer(res,async()=>({cancellation:await readAgentStartCancellation(res.locals.owner.id,res.locals.connectionId,String(req.params.id),req.query,now)})));
  router.get('/agent-starts/:id',(req,res)=>answer(res,()=>inspectAgentStart(res.locals.owner.id,res.locals.connectionId,String(req.params.id),req.query,now)));
  router.post('/agent-starts/:id/cancel',(req,res)=>answer(res,()=>cancelAgentStart(res.locals.owner.id,res.locals.connectionId,String(req.params.id),req.body,now)));
  router.post('/agent-starts/:id/accept',(req,res)=>answer(res,()=>acceptAgentStart(res.locals.owner.id,res.locals.connectionId,String(req.params.id),req.body,now)));
  router.post('/agent-starts/:id/receipt',(req,res)=>answer(res,()=>receiptAgentStart(res.locals.owner.id,res.locals.connectionId,String(req.params.id),req.body,now)));
  const cursor = (query: unknown) => parse(z.object({ cursor: z.string().max(500).optional() }).strict(), query).cursor;
  // List pages: the server's cursor, and up to 100 rows when the connector asks (lean tool results, 9 November 2026).
  const paged = (query: unknown) => parse(z.object({ cursor: z.string().max(500).optional(), limit: z.coerce.number().int().min(1).max(100).optional() }).strict(), query);
  router.post('/backgrounds/sync',(req,res)=>answer(res,()=>syncBackgrounds(res.locals.owner.id,res.locals.connectionId,req.body,now)));
  router.get('/background-controls',(req,res)=>answer(res,()=>readBackgroundCommands(res.locals.owner.id,res.locals.connectionId,req.query,now)));
  router.post('/background-controls/:id/receipt',(req,res)=>answer(res,()=>acknowledgeBackgroundCommand(res.locals.owner.id,res.locals.connectionId,String(req.params.id),req.body,now)));
  router.post('/participations/sync',(req,res)=>answer(res,()=>syncParticipations(res.locals.owner.id,res.locals.connectionId,req.body,now)));
  router.get('/participation-controls',(req,res)=>answer(res,()=>readParticipationCommands(res.locals.owner.id,res.locals.connectionId,req.query,now)));
  router.post('/participation-controls/:id/accept',(req,res)=>answer(res,()=>acceptParticipationCommand(res.locals.owner.id,res.locals.connectionId,String(req.params.id),req.body,now)));
  router.post('/participation-controls/:id/receipt',(req,res)=>answer(res,()=>acknowledgeParticipationCommand(res.locals.owner.id,res.locals.connectionId,String(req.params.id),req.body,now)));
  const projectId = (value: string) => { if (!validProjectId(value)) throw new Refusal('bad_input', 'Choose one of your projects.'); return value; };
  router.get('/needs-you', (req,res) => answer(res, () => readHumanRequests(res.locals.owner.id,req.query)));
  router.post('/needs-you/:id/answer', (req,res) => answer(res, () => {
    if (req.get('X-Mlswarm-Profile-Id') !== res.locals.owner.id) throw new Refusal('unauthorized','This computer is now connected to a different MyLittleSwarm account. Check which account you meant, then try again.');
    const {approved:_,...input} = parse(ANSWER_HUMAN.extend({approved:z.literal(true)}),req.body);
    return answerHumanRequest(res.locals.owner.id,String(req.params.id),input,now);
  }));
  router.post('/projects/private', (req, res) => answer(res, async () => {
    const { approved: _approved, ...input } = parse(CREATE_PRIVATE.extend({ approved: z.literal(true) }), req.body);
    if (req.get('X-Mlswarm-Profile-Id') !== res.locals.owner.id) throw new Refusal('unauthorized', 'This computer is now connected to a different MyLittleSwarm account. Check which account you meant, then try again.');
    const created = await createPrivateProject(res.locals.owner, input, now) as { id: string; memberLimit: number; messageProtection: string; replayed: boolean };
    return { ...created, ...projectStatus(created.id, await readWorkspace(res.locals.owner, created.id)), projectPagePath: await shortSharedLink(`/?project=${created.id}`) };
  }));
  router.get('/projects', (req, res) => answer(res, async () => {
    const query = parse(z.object({ cursor: z.string().max(500).optional(), scope: z.enum(['owned','joined','all']).default('all'), limit: z.coerce.number().int().min(1).max(100).optional() }).strict(), req.query);
    const result = await listMyProjects(res.locals.owner, query.cursor, 'all', query.limit);
    const rows = result.projects.filter(p => query.scope === 'all' || (query.scope === 'owned' ? p.role === 'owner' : p.role !== 'owner')), projects: object[] = [];
    for (let offset = 0; offset < rows.length; offset += 4) {
      projects.push(...await Promise.all(rows.slice(offset, offset + 4).map(async row => {
        const { execution, lifecycle, ...summary } = row;
        if (row.kind === 'proposal' || row.role !== 'owner') return { ...summary, state: withoutCopy(row.state), status: row.state.status, nextStep: row.state.next.description };
        return { ...summary, ...projectStatus(row.id, await readWorkspace(res.locals.owner, row.id)) };
      })));
    }
    // Filtering may produce an empty page. Preserve the source cursor so callers
    // can continue through sparse membership/owned pages without silently truncating.
    return { projects, next: result.next };
  }));
  router.get('/proposals', (req, res) => answer(res, async () => { const page = paged(req.query), result = await listProposals({ kind: 'person', operatorId: res.locals.owner.id }, page.cursor, false, page.limit); return { ...result, proposals: result.proposals.map(p => { const state = deriveProjectLifecycle({ kind: 'proposal', role: 'owner', proposalStatus: p.status }); return { ...p, proposalStatus: p.status, state: withoutCopy(state), status: state.status, nextStep: state.next.description }; }) }; }));
  router.get('/proposals/:id', (req, res) => answer(res, async () => { const result = await getProposal({ kind: 'person', operatorId: res.locals.owner.id }, projectId(req.params.id)); const state = deriveProjectLifecycle({ kind: 'proposal', role: 'owner', proposalStatus: result.proposal.status }); return { ...result, state: withoutCopy(state), status: state.status, nextStep: state.next.description, reviewerFeedback: result.proposal.feedback }; }));
  const selectedProject = (req: express.Request, res: Response) => {
    const id = projectId(String(req.params.id));
    if (req.method === 'POST' && req.get('X-Mlswarm-Profile-Id') !== res.locals.owner.id) throw new Refusal('unauthorized', 'This computer is now connected to a different MyLittleSwarm account. Check which account you meant, then try again.');
    return id;
  };
  const owned = async (req: express.Request, res: Response) => {
    const id = selectedProject(req,res);
    if (await projectRole(res.locals.owner, id) !== 'owner') throw new Refusal('forbidden', 'Only the owner can change setup.');
    return id;
  };
  router.post('/projects/:id/card', (req, res) => answer(res, async () => {
    const { approved: _, ...input } = parse(CARD_EDIT.extend({ approved: z.literal(true) }), req.body);
    return editCard(res.locals.owner, selectedProject(req, res), input, now);
  }));
  router.post('/projects/:id/configure', (req, res) => answer(res, async () => {
    const { approved: _, ...input } = parse(CONFIGURE.extend({ approved: z.literal(true) }), req.body);
    return configureWorkspace(res.locals.owner, await owned(req, res), input, now);
  }));
  router.post('/projects/:id/publish', (req, res) => answer(res, async () => {
    const { approved: _, ...input } = parse(FINALIZE.extend({ approved: z.literal(true) }), req.body);
    return finalizeWorkspace(res.locals.owner, await owned(req, res), input, now);
  }));
  router.post('/projects/:id/public-conversion', (req, res) => answer(res, async () => {
    const { approved: _, ...input } = parse(PUBLIC_CONVERSION.extend({ approved: z.literal(true) }), req.body);
    return convertProjectToPublic(res.locals.owner, selectedProject(req, res), input, now);
  }));
  router.post('/projects/:id/steering', (req,res)=>answer(res,()=>{if(req.get('X-Mlswarm-Profile-Id')!==res.locals.owner.id)throw new Refusal('unauthorized','This computer is connected to another account.');return inProject(projectId(req.params.id),()=>submitSteering(res.locals.owner.id,req.body,now));}));
  router.get('/projects/:id/steering/:operationId', (req,res)=>answer(res,()=>inProject(projectId(req.params.id),()=>steeringResult(res.locals.owner.id,String(req.params.operationId)))));
  router.get('/projects/:id/my-workers', (req, res) => answer(res, () => inProject(projectId(req.params.id), () => listMyWorkers(res.locals.owner.id, now))));
  router.post('/projects/:id/agents/:agentId/participation',(req,res)=>answer(res,()=>{
    if(req.get('X-Mlswarm-Profile-Id')!==res.locals.owner.id) throw new Refusal('unauthorized','This computer is now connected to a different MyLittleSwarm account. Check which account you meant, then try again.');
    return inProject(projectId(req.params.id),()=>requestParticipationControl(res.locals.owner.id,String(req.params.agentId),req.body,now));
  }));
  router.post('/projects/:id/project-update-settings', (req, res) => answer(res, () => inProject(projectId(req.params.id), () => saveProjectUpdateSettings(res.locals.owner.id, req.body, now))));
  // Members read through their computer what they can read on the website (owner decision, 25 October 2026).
  // Membership is checked first so an outsider gets "not found", never the 401 that means the computer is no longer connected.
  const member = async (req: express.Request, res: Response) => { const id = projectId(String(req.params.id)); return { id, role: await projectRole(res.locals.owner, id) }; };
  const person = (res: Response) => ({ kind: 'person' as const, person: res.locals.owner as WithId<Profile> });
  router.get('/projects/:id/overview', (req, res) => answer(res, async () => {
    const id = projectId(String(req.params.id)), w = await readWorkspace(res.locals.owner, id);
    const [updateSettings, publicConversion] = await Promise.all([
      w.role === 'owner' ? inProject(id, () => readProjectUpdateSettings(res.locals.owner.id)) : null,
      w.role === 'owner' && w.privacy ? readPublicConversion(res.locals.owner, id) : null]);
    return { ...w, status: projectStatus(id, w), ...(updateSettings ? { updateSettings } : {}), ...(publicConversion ? { publicConversion } : {}) };
  }));
  router.get('/projects/:id/agents', (req, res) => answer(res, async () => {
    const { id } = await member(req, res), query = parse(z.object({ q: z.string().max(40).optional(), cursor: z.string().max(500).optional(), limit: z.coerce.number().int().min(1).max(100).optional() }).strict(), req.query);
    return inProject(id, () => findAgents({ namePrefix: query.q, cursor: query.cursor, limit: query.limit }, now, res.locals.owner.id));
  }));
  router.get('/projects/:id/conversations', (req, res) => answer(res, async () => { const { id } = await member(req, res), page = paged(req.query); return inProject(id, () => readConversations(page.cursor, now, undefined, page.limit)); }));
  router.get('/projects/:id/conversations/:threadId', (req, res) => answer(res, async () => { const { id } = await member(req, res), page = paged(req.query); return inProject(id, () => readThread(String(req.params.threadId), { cursor: page.cursor }, now, undefined, page.limit)); }));
  router.get('/projects/:id/chat', (req, res) => answer(res, async () => { const { id } = await member(req, res), page = paged(req.query); return readHumanChat(id, res.locals.owner, page.cursor, now, page.limit); }));
  router.get('/projects/:id/updates', (req, res) => answer(res, async () => { const { id } = await member(req, res); return readProgressUpdates(id, person(res), req.query, now); }));
  router.get('/projects/:id/tasks', (req, res) => answer(res, async () => { const { id } = await member(req, res); return inProject(id, () => listNativeTasks(person(res), req.query, now)); }));
  router.get('/projects/:id/tasks/:taskId', (req, res) => answer(res, async () => { const { id } = await member(req, res); return inProject(id, () => getNativeTask(person(res), String(req.params.taskId), req.query, now)); }));
  router.post('/projects/:id/agents', (req, res) => answer(res, async () => {
    const input = parse(z.object({ client_request_id: z.string().regex(/^[\w-]{1,64}$/), names: z.array(z.string().regex(/^[\w-]{1,64}$/)).min(1).max(10), approved: z.literal(true) }).strict(), req.body);
    return inProject(projectId(req.params.id), () => registerAgentTeam(res.locals.owner.id, input.names, input.client_request_id, now, true));
  }));
  // Any member connects their own agents; membership is checked in the transaction.
  router.post('/projects/:id/agents/connect', (req, res) => answer(res, async () => { return inProject(projectId(req.params.id), () => connectOwnAgent(res.locals.owner.id, parse(connectOwnAgentInput, req.body), now, res.locals.connectionId)); }));
  // The projects this person belongs to, by name, so their coding agent finds one from what they typed.
  router.get('/member-projects', (req, res) => answer(res, async () => { const result = await listProjects(res.locals.owner, cursor(req.query)); return { projects: result.projects.map(p => ({ projectId: p.id, projectName: p.name })), next: result.next }; }));
  // The limits a person chose in their coding agent are saved where My agents shows them.
  router.post('/projects/:id/agents/:agentId/settings', (req, res) => answer(res, async () => { const agentId = String(req.params.agentId); if (!/^[\w-]{1,200}$/.test(agentId)) throw new Refusal('bad_input', 'Use the agent’s exact ID from your agent list.'); return inProject(projectId(req.params.id), () => saveWorkSettings(res.locals.owner.id, agentId, parse(workSettingsInput, req.body))); }));
  router.post('/projects/:id/agents/:agentId/persona', (req, res) => answer(res, async () =>
    inProject(projectId(req.params.id), () => saveAgentPersona(res.locals.owner.id, String(req.params.agentId), req.body, now))));
  router.post('/projects/:id/control', (req, res) => answer(res, async () => {
    if (req.get('X-Mlswarm-Profile-Id') !== res.locals.owner.id) throw new Refusal('unauthorized', 'This computer is now connected to a different MyLittleSwarm account. Check which account you meant, then try again.');
    const { approved: _, ...input } = parse(CONTROL.extend({ approved: z.literal(true) }), req.body);
    return controlWorkspace(res.locals.owner, projectId(req.params.id), input, now);
  }));
  // Archive only hides the project from this person's own list; nothing about the project changes.
  router.post('/projects/:id/personal-archive', (req, res) => answer(res, async () => {
    if (req.get('X-Mlswarm-Profile-Id') !== res.locals.owner.id) throw new Refusal('unauthorized', 'This computer is now connected to a different MyLittleSwarm account. Check which account you meant, then try again.');
    const { approved: _, ...input } = parse(PERSONAL_ARCHIVE.extend({ approved: z.literal(true) }), req.body);
    return setPersonalArchive(res.locals.owner, projectId(req.params.id), input, now);
  }));
  return router;
}
