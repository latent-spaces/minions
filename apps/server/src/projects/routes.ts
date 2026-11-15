import { editMergePolicy, readMergePolicy } from './merge-policy.js';
import { readNativeTaskSettings, saveNativeTaskSettings } from './native-task-settings.js';
import { readNativeTeamSettings, saveNativeTeamSettings } from './native-team-settings.js';
import { getNativeTeam, listNativeTeams } from './native-teams.js';
import { listNativeTasks, listNativeTaskChanges, getNativeTask, mutateNativeTask } from './native-tasks.js';
import { recordProjectVisit } from '../onboarding/journeys.js';
import { MERGING_QUERY, readMergingAccess } from './merging.js';
import { karmaProgress } from '../community/karma.js';
import { projectRole } from './access.js';
import { PERSONAL_ARCHIVE, PERSONAL_STAR, setPersonalArchive, setPersonalStar } from './personal-archive.js';
import { readProjectUpdateSettings, saveProjectUpdateSettings } from './progress-settings.js';
import express, { type Request, type Response } from 'express';
import { z } from 'zod';
import { personIdentityFromIdToken, SIGN_IN_REQUIRED } from '../auth.js';
import { bearerToken } from '../bearer.js';
import { RecentlyUsed, requestLimits } from '../request-state.js';
import { Refusal, sendRefusal } from '../errors.js';
import { inProject } from '../firestore.js';
import { onboardingRoutes } from '../onboarding/routes.js';
import { v2Routes } from '../v2/routes.js';
import { viewRoutes } from '../view/routes.js';
import { publicProjectRoutes } from './public.js';
import { starterProjects } from './starters.js';
import { CATALOG_INPUT, CATALOG_QUERY, publishCatalog, readCatalog, readStartingSoon, readCatalogSettings } from './catalog.js';
import { convertProjectToPublic, readPublicConversion } from './public-conversion.js';
import { DELIVERY_QUERY, DELIVERY_RETRY, listDeliveryJobs, retryDeliveryJob } from '../v2/fanout-admin.js';
import { validProjectId } from './access.js';
import { editCommunityRules } from './community-rules.js';
import { readAgentPersona, saveAgentPersona } from './agent-participation.js';
import { readCommunication, saveCommunication } from './communication.js';
import { listMyWorkers } from './worker-sessions.js';
import { requestBackgroundControl } from './background-controls.js';
import { requestParticipationControl } from './chat-controls.js';
import { readAgentEnvironment } from './agent-environment.js';
import { CREATE_PRIVATE, createPrivateProject, leavePrivateProject } from './private.js';
import { JOIN_PROJECT, joinWorkspace, CONFIGURE, CONTROL, finalizeWorkspace, FINALIZE, configureWorkspace, controlWorkspace, editCard, listCardVersions, listProjectShortcuts, listProjects, listMyProjects, readWorkspace } from './store.js';

async function person(req: Request) {
  const token = bearerToken(req.headers.authorization);
  if (!token) throw new Refusal('unauthorized', SIGN_IN_REQUIRED);
  return personIdentityFromIdToken(token);
}
function fail(res: Response, error: unknown) {
  if (error instanceof Refusal) sendRefusal(res, error, error.retryAfterSeconds !== undefined ? { retry_after_seconds: error.retryAfterSeconds } : {});
  else if (error instanceof z.ZodError) res.status(400).json({ error: 'bad_input', message: 'Check the request details and retry.' });
  else { console.error('A project request failed.', error); res.status(500).json({ error: 'internal_error', message: 'Something went wrong loading this project. Try again in a moment.' }); }
}
export function projectManagementRoutes(now: () => number) {
  const router = express.Router();
  // The 12,000-character rules body can occupy 72 KB when JSON escapes it.
  router.use('/:id/community-rules', express.json({ limit: '80kb' }));
  // Task descriptions/comments can contain escaped Unicode up to their explicit field bounds.
  router.use('/:id/tasks', express.json({ limit: '80kb' }));
  router.use(express.json({ limit: '16kb' }));
  const answer = (res: Response, work: () => Promise<unknown>) => void Promise.resolve().then(work).then(value => res.json(value), error => fail(res, error));
  const parsed = <T>(schema: z.ZodType<T>, value: unknown) => { const p = schema.safeParse(value); if (!p.success) throw new Refusal('bad_input', 'Some settings are missing or not in the expected form. Check them, then try again.'); return p.data; };
  const admission = requestLimits.limiter(() => 'project-management', 60, 60_000);
  const readAdmission = requestLimits.limiter(() => 'project-management-read', 120, 60_000);
  router.use(async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    try {
      const { person: operator, adminAuthenticated } = await person(req); res.locals.operator = operator; res.locals.coFounder = adminAuthenticated;
      // Several independently refreshed panels must not consume an owner's write allowance.
      const retry = (req.method === 'GET' ? readAdmission : admission)(operator.id, now());
      if (retry > 0) throw new Refusal('rate_limited', 'Too many requests. Wait a moment, then try again.', Math.ceil(retry / 1000));
      next();
    } catch (error) { fail(res, error); }
  });
  const publicAdmission = requestLimits.limiter(() => 'project-discovery', 60, 60_000);
  // Discovery reads are rate limited per address. Publication does not grant private membership.
  router.get(['/starters', '/explore'], (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const retry = publicAdmission(req.ip ?? 'unknown', now());
    if (retry > 0) { fail(res, new Refusal('rate_limited', 'Too many requests. Wait a moment, then try again.', Math.ceil(retry / 1000))); return; }
    next();
  });
  router.get('/starters', (_req, res) => res.json({ starters: starterProjects, kind: 'starter_briefs', approvalRequired: true }));
  router.get('/explore', (req, res) => answer(res, async () => {
    const query = parsed(CATALOG_QUERY, req.query);
    const [result, startingSoon] = await Promise.all([readCatalog(query, now), query.project ? Promise.resolve([]) : readStartingSoon(query, now)]);
    if (query.project && !result.projects.length) throw new Refusal('not_found', 'This project isn’t published to Explore.');
    return { ...result, startingSoon };
  }));
  router.use('/public/:id', publicProjectRoutes(now));
  const id = (req: Request) => { if (!validProjectId(req.params.id)) throw new Refusal('bad_input', 'Choose a project from your project list.'); return req.params.id; };
  const privatePerson = (req: Request, res: Response) => {
    const person = res.locals.operator;
    if (req.headers['x-minions-profile-id'] !== person.id) throw new Refusal('unauthorized', 'You’re now signed in to a different Minions account. Reload the page, then try again.');
    return person;
  };
  router.get('/:id/native-task-settings', (req, res) => answer(res, () => inProject(id(req), () => readNativeTaskSettings(res.locals.operator.id))));
  router.get('/:id/native-team-settings', (req, res) => answer(res, () => inProject(id(req), () => readNativeTeamSettings(res.locals.operator.id))));
  router.post('/:id/native-team-settings', (req, res) => answer(res, () => inProject(id(req), () => saveNativeTeamSettings(privatePerson(req, res).id, req.body, now))));
  router.get('/:id/teams', (req, res) => answer(res, () => inProject(id(req), () => listNativeTeams({ kind: 'person', person: res.locals.operator }, req.query, now))));
  router.get('/:id/teams/:teamId', (req, res) => answer(res, () => inProject(id(req), () => getNativeTeam({ kind: 'person', person: res.locals.operator }, String(req.params.teamId), req.query, now))));
  router.post('/:id/native-task-settings', (req, res) => answer(res, () => {
    return inProject(id(req), () => saveNativeTaskSettings(privatePerson(req, res).id, req.body, now));
  }));
  router.get('/:id/tasks', (req, res) => answer(res, () => inProject(id(req), () => listNativeTasks({ kind: 'person', person: res.locals.operator }, req.query, now))));
  // T2: tasks changed since a cursor (before /:taskId, which would otherwise take "changes" as an id). No client uses it yet.
  router.get('/:id/tasks/changes', (req, res) => answer(res, () => inProject(id(req), () => listNativeTaskChanges({ kind: 'person', person: res.locals.operator }, req.query, now))));
  router.get('/:id/tasks/:taskId', (req, res) => answer(res, () => inProject(id(req), () => getNativeTask({ kind: 'person', person: res.locals.operator }, String(req.params.taskId), req.query, now))));
  router.post('/:id/tasks', (req, res) => answer(res, () => {
    return inProject(id(req), () => mutateNativeTask({ kind: 'person', person: privatePerson(req, res) }, req.body, now));
  }));
  router.get('/', (req, res) => answer(res, async () => {
    const query = parsed(z.object({ cursor: z.string().max(500).optional(), view: z.enum(['all', 'current', 'archived', 'active']).default('all') }).strict(), req.query);
    return listProjects(res.locals.operator, query.cursor, query.view);
  }));
  router.get('/shortcuts', (_req, res) => answer(res, () => listProjectShortcuts(res.locals.operator)));
  router.get('/mine', (req, res) => answer(res, async () => {
    const query = parsed(z.object({ cursor: z.string().max(500).optional(), view: z.enum(['all', 'current', 'archived', 'active']).default('all') }).strict(), req.query);
    return listMyProjects(res.locals.operator, query.cursor, query.view);
  }));
  router.post('/:id/personal-archive', (req, res) => answer(res, async () =>
    setPersonalArchive(privatePerson(req, res), id(req), parsed(PERSONAL_ARCHIVE, req.body), now)));
  router.post('/:id/personal-star', (req, res) => answer(res, async () =>
    setPersonalStar(privatePerson(req, res), id(req), parsed(PERSONAL_STAR, req.body), now)));
  router.post('/private', (req, res) => answer(res, async () => createPrivateProject(privatePerson(req, res), parsed(CREATE_PRIVATE, req.body), now)));
  router.post('/:id/visit', (req, res) => answer(res, () => {
    parsed(z.object({}).strict(), req.body);
    return recordProjectVisit(privatePerson(req, res), id(req), now);
  }));
  router.get('/:id/my-karma', (req, res) => answer(res, async () => {
    parsed(z.object({}).strict(), req.query);
    const projectId = id(req), actor = res.locals.operator;
    await projectRole(actor, projectId);
    const result = await karmaProgress({ operatorId: actor.id }, now);
    await projectRole(actor, projectId);
    return result;
  }));
  router.post('/:id/leave', (req, res) => answer(res, async () => {
    const body = parsed(z.object({ client_request_id: z.string().uuid() }).strict(), req.body);
    return leavePrivateProject(privatePerson(req, res), id(req), body.client_request_id, now);
  }));
  router.get('/:id/catalog', (req, res) => answer(res, async () => readCatalogSettings(res.locals.operator, id(req))));
  router.get('/:id/public-conversion', (req, res) => answer(res, () => readPublicConversion(res.locals.operator, id(req))));
  router.post('/:id/public-conversion', (req, res) => answer(res, () => convertProjectToPublic(res.locals.operator, id(req), req.body, now)));
  router.post('/:id/catalog', (req, res) => answer(res, async () => publishCatalog(res.locals.operator, id(req), parsed(CATALOG_INPUT, req.body), now)));
  router.get('/:id/delivery', (req, res) => answer(res, async () => listDeliveryJobs(res.locals.operator, id(req), parsed(DELIVERY_QUERY, req.query), now)));
  router.post('/:id/delivery/:jobId/retry', (req, res) => answer(res, async () => retryDeliveryJob(res.locals.operator, id(req), String(req.params.jobId), parsed(DELIVERY_RETRY, req.body), now)));
  router.post('/:id/join', (req, res) => answer(res, async () => joinWorkspace(res.locals.operator, id(req), parsed(JOIN_PROJECT, req.body), now)));
  router.get('/:id', (req, res) => answer(res, async () => readWorkspace(res.locals.operator, id(req))));
  router.post('/:id/finalize', (req, res) => answer(res, async () => finalizeWorkspace(res.locals.operator, id(req), parsed(FINALIZE, req.body), now)));
  router.post('/:id/configure', (req, res) => answer(res, async () => configureWorkspace(res.locals.operator, id(req), parsed(CONFIGURE, req.body), now)));
  router.post('/:id/control', (req, res) => answer(res, async () => controlWorkspace(res.locals.operator, id(req), parsed(CONTROL, req.body), now)));
  // The Card edit validates its own body, so a refusal names the field or the 12,000-byte bound.
  router.post('/:id/card', (req, res) => answer(res, async () => editCard(res.locals.operator, id(req), req.body, now)));
  router.get('/:id/merge-access', (req, res) => answer(res, () => { parsed(z.object({}).strict(), req.query); return readMergePolicy(res.locals.operator.id, id(req), now); }));
  router.post('/:id/merge-access', (req, res) => answer(res, () => editMergePolicy(res.locals.operator.id, id(req), req.body, now)));
  router.get('/:id/merging', (req, res) => answer(res, () => readMergingAccess(res.locals.operator.id, id(req), parsed(MERGING_QUERY, req.query), now)));
  router.post('/:id/community-rules', (req, res) => answer(res, async () => editCommunityRules(res.locals.operator, id(req), req.body, now)));
  router.get('/:id/project-update-settings', (req, res) => answer(res, async () => {
    parsed(z.object({}).strict(), req.query);
    return inProject(id(req), () => readProjectUpdateSettings(res.locals.operator.id));
  }));
  router.post('/:id/project-update-settings', (req, res) => answer(res, async () => {
    parsed(z.object({}).strict(), req.query);
    return inProject(id(req), () => saveProjectUpdateSettings(res.locals.operator.id, req.body, now));
  }));
  router.get('/:id/communication', (req, res) => answer(res, async () => {
    parsed(z.object({}).strict(), req.query);
    return inProject(id(req), () => readCommunication(res.locals.operator.id));
  }));
  router.post('/:id/communication', (req, res) => answer(res, async () => {
    parsed(z.object({}).strict(), req.query);
    return inProject(id(req), () => saveCommunication(res.locals.operator.id, req.body, now));
  }));
  router.get('/:id/agents/:agentId/persona', (req, res) => answer(res, async () => {
    if (Object.keys(req.query).length) throw new Refusal('bad_input', 'A persona read does not accept filters.');
    return inProject(id(req), () => readAgentPersona(res.locals.operator.id, String(req.params.agentId)));
  }));
  router.get('/:id/agents/:agentId/environment', (req, res) => answer(res, async () => {
    parsed(z.object({}).strict(), req.query);
    return inProject(id(req), () => readAgentEnvironment(res.locals.operator.id, String(req.params.agentId), now));
  }));
  router.get('/:id/my-workers', (req, res) => answer(res, () => inProject(id(req), () => listMyWorkers(res.locals.operator.id, now))));
  router.post('/:id/agents/:agentId/background-control', (req,res) => answer(res, () => inProject(id(req), () => requestBackgroundControl(res.locals.operator.id,String(req.params.agentId),req.body,now))));
  router.post('/:id/agents/:agentId/participation', (req,res) => answer(res, () => inProject(id(req), () => requestParticipationControl(res.locals.operator.id,String(req.params.agentId),req.body,now))));
  router.post('/:id/agents/:agentId/persona', (req, res) => answer(res, async () => {
    if (Object.keys(req.query).length) throw new Refusal('bad_input', 'A persona save does not accept filters.');
    return inProject(id(req), () => saveAgentPersona(res.locals.operator.id, String(req.params.agentId), req.body, now));
  }));
  router.get('/:id/card/versions', (req, res) => answer(res, async () => {
    if (req.query.cursor !== undefined && typeof req.query.cursor !== 'string') throw new Refusal('bad_input', 'Use the cursor returned by the project card history.');
    return listCardVersions(res.locals.operator, id(req), req.query.cursor as string | undefined);
  }));
  return router;
}

// Process-local router capacity; a hit keeps a busy project resident.
export const PROJECT_ROUTERS_PER_PROCESS = 100;

// Each project gets its own router instances, so overview/control caches and wake checks stay
// scoped to it. This is the only mount of the agent, viewer and joining routes.
export function projectRuntimeRoutes(now: () => number) {
  // Eviction drops only caches and write suppression; quotas live in the shared request-state store.
  const router = express.Router({ mergeParams: true }), scoped = new RecentlyUsed<ReturnType<typeof express.Router>>(PROJECT_ROUTERS_PER_PROCESS);
  router.use((req, res, next) => {
    const id = req.params.projectId;
    if (!validProjectId(id)) { res.status(404).json({ error: 'not_found', message: 'This project wasn’t found. Choose one of your projects.' }); return; }
    const routes = scoped.get(id, () => {
      const routes = express.Router(); routes.use('/v2', v2Routes(now)); routes.use('/api/view', viewRoutes(now)); routes.use('/api/join', onboardingRoutes(now));
      return routes;
    });
    inProject(id, () => routes(req, res, next));
  });
  return router;
}
