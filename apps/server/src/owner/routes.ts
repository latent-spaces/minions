import { reportMergePolicy } from '../projects/merge-policy.js';
import { shortSharedLink } from '../shared-links.js';
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
import { deriveProjectLifecycle } from '@minions/contracts';
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
import { personIdentityFromIdToken } from '../auth.js';
import { bearerToken } from '../bearer.js';
import { findAgents } from '../v2/agents.js';
import { readConversations, readThread } from '../view/conversations.js';
import { readHumanChat } from '../projects/chat.js';
import { readProgressUpdates } from '../projects/progress.js';
import { listNativeTasks, getNativeTask } from '../projects/native-tasks.js';
import { inProject, type Profile, type WithId } from '../firestore.js';
import { Refusal, sendRefusal } from '../errors.js';
import { requestLimits } from '../request-state.js';
import { listProposals, getProposal } from '../community/proposals.js';
import { CONFIGURE, FINALIZE, configureWorkspace, finalizeWorkspace, editCard, CONTROL, controlWorkspace, listMyProjects, listProjects, readWorkspace } from '../projects/store.js';
import { projectRole, validProjectId } from '../projects/access.js';
import { PERSONAL_ARCHIVE, setPersonalArchive } from '../projects/personal-archive.js';
import { CREATE_PRIVATE, createPrivateProject } from '../projects/private.js';

// One process-wide expensive-auth budget, also shared by computer-only hosting ingress.
export const ownerVerification = boundedVerification();
const parse = <T>(schema: z.ZodType<T>, value: unknown): T => { const result = schema.safeParse(value); if (!result.success) throw new Refusal('bad_input', 'Some fields in this request are missing or not in the expected form.'); return result.data; };

function projectStatus(id: string, w: Awaited<ReturnType<typeof readWorkspace>>) {
  const state = w.state;
  return { projectId: id, title: w.definition.title, revision: w.revision, state: withoutCopy(state), status: state.status, nextStep: state.next.description,
    participantCount: w.participantCount, minimumContributors: w.setup.minContributors, contributorsNeeded: state.contributorsNeeded,
    targetStartDate: w.setup.startDeadline, published: w.listed, blockers: state.readiness.blockers.map(b => b.reason),
    canStart: state.readiness.canStart, canStartWithFewer: state.readiness.canStartWithFewer, startsAgents: false };
}
function fail(res: Response, error: unknown) {
  if (error instanceof Refusal) sendRefusal(res, error);
  else { console.error('Owner request failed.', error); res.status(500).json({ error: 'internal_error', message: 'Something went wrong on Minions. Try again in a moment.' }); }
}
// Mounted before the SDK's default 100 KiB parser for this one bounded route.
// Preserve its Host-before-body protection when listening on loopback.
export function participationSnapshotParser(host: string) {
  const router = express.Router();
  if (['127.0.0.1', 'localhost', '::1'].includes(host)) router.use(localhostHostValidation());
  router.use(express.json({ limit: '300kb' }));
  return router;
}
export function ownerRoutes(now: () => number) {
  const router = express.Router(); router.use(express.json({ limit: '300kb' }));
  router.use((req, res, next) => { const limit=['/participations/sync','/backgrounds/sync'].includes(req.path) ? 300*1024 : 16*1024;
    if (req.body !== undefined && Buffer.byteLength(JSON.stringify(req.body), 'utf8') > limit) { res.status(413).set('Cache-Control', 'no-store').json({ error: 'bad_input', message: 'This request is too large.' }); } else next(); });
  const verify = ownerVerification;
  const browserPerson = (req: Request) => verify(async () => (await personIdentityFromIdToken(bearerToken(req.headers.authorization) ?? '')).person);
  const personLimit = requestLimits.limiter(() => 'owner-person', 60, 60_000);
  const observationLimit = requestLimits.limiter(() => 'owner-observation',120,60_000);
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const admit = (limit: ReturnType<typeof requestLimits.limiter>, key: string) => {
    const retry = limit(key, now());
    if (retry > 0) throw new Refusal('rate_limited', 'Too many requests. Wait a moment, then try again.', Math.ceil(retry / 1000));
  };
  const personAdmission = (profileId: string) => admit(personLimit, profileId);
  const answer = (res: Response, fn: () => Promise<unknown>) => void Promise.resolve().then(fn).then(v => res.json(v), e => fail(res, e));
  // The owner's browser reads below have no budget: the one local owner's viewing is never refused.
  router.get('/notifications', (req,res)=>answer(res,async()=>{
    const person=await browserPerson(req);
    if(req.get('X-Minions-Profile-Id')!==person.id)throw new Refusal('unauthorized','Your selected account changed.');
    return readNotifications(person.id,req.query);
  }));
  router.post('/notifications/read-all', (req,res)=>answer(res,async()=>{
    const person=await browserPerson(req);personAdmission(person.id);parse(z.object({}).strict(),req.body);
    if(req.get('X-Minions-Profile-Id')!==person.id)throw new Refusal('unauthorized','Your selected account changed.');
    return markAllNotificationsRead(person.id,now);
  }));
  router.post('/notifications/:id/read', (req,res)=>answer(res,async()=>{
    const person=await browserPerson(req);personAdmission(person.id);parse(z.object({}).strict(),req.body);
    if(req.get('X-Minions-Profile-Id')!==person.id)throw new Refusal('unauthorized','Your selected account changed.');
    return markNotificationRead(person.id,String(req.params.id),now);
  }));
  // The connector reads the owner's identity here too: it signs in with the same local session as the app.
  router.get('/profile', (req,res) => answer(res, async () => { const person=await browserPerson(req); return {profileId:person.id,name:person.name,email:person.email}; }));
  // The engine's one computer: whether its shared service is online and which coding tools it offers.
  router.get('/runtime', (req,res) => answer(res, async () => { const person=await browserPerson(req); return {runtime:readinessView((await runtimeReadiness.doc(person.id).get()).data(),now())}; }));
  router.post('/web-agent-starts',(req,res)=>answer(res,async()=>{
    const person=await browserPerson(req);personAdmission(person.id);
    if(req.get('X-Minions-Profile-Id')!==person.id)throw new Refusal('unauthorized','Minions now signs in a different account. Check which account you meant, then try again.');
    return createWebAgentStart(person.id,req.body,now);
  }));
  router.get('/web-agent-starts/:id',(req,res)=>answer(res,async()=>{const person=await browserPerson(req);return readWebAgentStart(person.id,String(req.params.id),now);}));
  router.use(async (req, res, next) => {
    try {
      // The connector signs in with the owner's local session, like the app (owner decision, 15 November 2026).
      const session = await verify(() => personIdentityFromIdToken(bearerToken(req.headers.authorization) ?? ''));
      // Presence and mailbox observations must not exhaust the human action budget.
      const observation = (req.method==='GET' && (req.path==='/agent-starts' || req.path==='/repository-access'))
        || (req.method==='POST' && (req.path==='/runtime/readiness'||req.path==='/repository-access/observations'||req.path==='/repository-access/merge-policy'));
      admit(observation ? observationLimit : personLimit, session.person.id);
      res.locals.owner=session.person;res.locals.coFounder=session.adminAuthenticated;next();
    } catch (e) { fail(res,e); }
  });
  router.get('/repository-access',(req,res)=>answer(res,()=>{parse(z.object({}).strict(),req.query);return repositoryAccess(res.locals.owner.id);}));
  router.post('/repository-access/merge-policy',(req,res)=>answer(res,()=>reportMergePolicy(res.locals.owner.id,req.body,now)));
  router.post('/repository-access/observations',(req,res)=>answer(res,()=>publishGitHubAccess(res.locals.owner.id,req.body,now)));
  router.post('/runtime/readiness',(req,res)=>answer(res,()=>publishRuntimeReadiness(res.locals.owner.id,req.body,now)));
  router.get('/agent-starts',(req,res)=>answer(res,()=>readAgentStarts(res.locals.owner.id,req.query,now)));
  // A coding chat that adds an agent queues its run for this same computer.
  router.post('/agent-starts',(req,res)=>answer(res,()=>createWebAgentStart(res.locals.owner.id,req.body,now)));
  router.get('/agent-start-controls/:id',(req,res)=>answer(res,async()=>({cancellation:await readAgentStartCancellation(res.locals.owner.id,String(req.params.id),req.query,now)})));
  router.get('/agent-starts/:id',(req,res)=>answer(res,()=>inspectAgentStart(res.locals.owner.id,String(req.params.id),req.query,now)));
  router.post('/agent-starts/:id/cancel',(req,res)=>answer(res,()=>cancelAgentStart(res.locals.owner.id,String(req.params.id),req.body,now)));
  router.post('/agent-starts/:id/accept',(req,res)=>answer(res,()=>acceptAgentStart(res.locals.owner.id,String(req.params.id),req.body,now)));
  router.post('/agent-starts/:id/receipt',(req,res)=>answer(res,()=>receiptAgentStart(res.locals.owner.id,String(req.params.id),req.body,now)));
  const cursor = (query: unknown) => parse(z.object({ cursor: z.string().max(500).optional() }).strict(), query).cursor;
  // List pages: the server's cursor, and up to 100 rows when the connector asks (lean tool results, 9 November 2026).
  const paged = (query: unknown) => parse(z.object({ cursor: z.string().max(500).optional(), limit: z.coerce.number().int().min(1).max(100).optional() }).strict(), query);
  router.post('/backgrounds/sync',(req,res)=>answer(res,()=>syncBackgrounds(res.locals.owner.id,req.body,now)));
  router.get('/background-controls',(req,res)=>answer(res,()=>readBackgroundCommands(res.locals.owner.id,req.query,now)));
  router.post('/background-controls/:id/receipt',(req,res)=>answer(res,()=>acknowledgeBackgroundCommand(res.locals.owner.id,String(req.params.id),req.body,now)));
  router.post('/participations/sync',(req,res)=>answer(res,()=>syncParticipations(res.locals.owner.id,req.body,now)));
  router.get('/participation-controls',(req,res)=>answer(res,()=>readParticipationCommands(res.locals.owner.id,req.query,now)));
  router.post('/participation-controls/:id/accept',(req,res)=>answer(res,()=>acceptParticipationCommand(res.locals.owner.id,String(req.params.id),req.body,now)));
  router.post('/participation-controls/:id/receipt',(req,res)=>answer(res,()=>acknowledgeParticipationCommand(res.locals.owner.id,String(req.params.id),req.body,now)));
  const projectId = (value: string) => { if (!validProjectId(value)) throw new Refusal('bad_input', 'Choose one of your projects.'); return value; };
  router.get('/needs-you', (req,res) => answer(res, () => readHumanRequests(res.locals.owner.id,req.query)));
  router.post('/needs-you/:id/answer', (req,res) => answer(res, () => {
    if (req.get('X-Minions-Profile-Id') !== res.locals.owner.id) throw new Refusal('unauthorized','Minions now signs in a different account. Check which account you meant, then try again.');
    const {approved:_,...input} = parse(ANSWER_HUMAN.extend({approved:z.literal(true)}),req.body);
    return answerHumanRequest(res.locals.owner.id,String(req.params.id),input,now);
  }));
  router.post('/projects/private', (req, res) => answer(res, async () => {
    const { approved: _approved, ...input } = parse(CREATE_PRIVATE.extend({ approved: z.literal(true) }), req.body);
    if (req.get('X-Minions-Profile-Id') !== res.locals.owner.id) throw new Refusal('unauthorized', 'Minions now signs in a different account. Check which account you meant, then try again.');
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
    if (req.method === 'POST' && req.get('X-Minions-Profile-Id') !== res.locals.owner.id) throw new Refusal('unauthorized', 'Minions now signs in a different account. Check which account you meant, then try again.');
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
  router.post('/projects/:id/steering', (req,res)=>answer(res,()=>{if(req.get('X-Minions-Profile-Id')!==res.locals.owner.id)throw new Refusal('unauthorized','Minions now signs in a different account.');return inProject(projectId(req.params.id),()=>submitSteering(res.locals.owner.id,req.body,now));}));
  router.get('/projects/:id/steering/:operationId', (req,res)=>answer(res,()=>inProject(projectId(req.params.id),()=>steeringResult(res.locals.owner.id,String(req.params.operationId)))));
  router.get('/projects/:id/my-workers', (req, res) => answer(res, () => inProject(projectId(req.params.id), () => listMyWorkers(res.locals.owner.id, now))));
  router.post('/projects/:id/agents/:agentId/participation',(req,res)=>answer(res,()=>{
    if(req.get('X-Minions-Profile-Id')!==res.locals.owner.id) throw new Refusal('unauthorized','Minions now signs in a different account. Check which account you meant, then try again.');
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
  router.post('/projects/:id/agents/connect', (req, res) => answer(res, async () => { return inProject(projectId(req.params.id), () => connectOwnAgent(res.locals.owner.id, parse(connectOwnAgentInput, req.body), now)); }));
  // The projects this person belongs to, by name, so their coding agent finds one from what they typed.
  router.get('/member-projects', (req, res) => answer(res, async () => { const result = await listProjects(res.locals.owner, cursor(req.query)); return { projects: result.projects.map(p => ({ projectId: p.id, projectName: p.name })), next: result.next }; }));
  // The limits a person chose in their coding agent are saved where My agents shows them.
  router.post('/projects/:id/agents/:agentId/settings', (req, res) => answer(res, async () => { const agentId = String(req.params.agentId); if (!/^[\w-]{1,200}$/.test(agentId)) throw new Refusal('bad_input', 'Use the agent’s exact ID from your agent list.'); return inProject(projectId(req.params.id), () => saveWorkSettings(res.locals.owner.id, agentId, parse(workSettingsInput, req.body))); }));
  router.post('/projects/:id/agents/:agentId/persona', (req, res) => answer(res, async () =>
    inProject(projectId(req.params.id), () => saveAgentPersona(res.locals.owner.id, String(req.params.agentId), req.body, now))));
  router.post('/projects/:id/control', (req, res) => answer(res, async () => {
    if (req.get('X-Minions-Profile-Id') !== res.locals.owner.id) throw new Refusal('unauthorized', 'Minions now signs in a different account. Check which account you meant, then try again.');
    const { approved: _, ...input } = parse(CONTROL.extend({ approved: z.literal(true) }), req.body);
    return controlWorkspace(res.locals.owner, projectId(req.params.id), input, now);
  }));
  // Archive only hides the project from this person's own list; nothing about the project changes.
  router.post('/projects/:id/personal-archive', (req, res) => answer(res, async () => {
    if (req.get('X-Minions-Profile-Id') !== res.locals.owner.id) throw new Refusal('unauthorized', 'Minions now signs in a different account. Check which account you meant, then try again.');
    const { approved: _, ...input } = parse(PERSONAL_ARCHIVE.extend({ approved: z.literal(true) }), req.body);
    return setPersonalArchive(res.locals.owner, projectId(req.params.id), input, now);
  }));
  return router;
}
