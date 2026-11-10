import { untrusted } from '../v2/untrusted.js';
import { createHash } from 'node:crypto';
import { FieldPath, Filter } from '../firestore.js';
import * as z from 'zod';
import type { HumanRequest, HumanRequestPage } from '@mlswarm/contracts';
import { agents, collection, currentProjectId, db, inProject, profiles, projectDoc } from '../firestore.js';
import { cardDoc } from './card.js';
import { Refusal } from '../errors.js';
import { assertMembership, assertProjectWritable } from './access.js';
import { assertRunInTransaction } from '../v2/runs.js';
import { countedWorkSignal, workSignalDoc } from '../v2/work-signals.js';
import { runs } from '../v2/records.js';
import { decodeCursor, encodeCursor } from '../cursor.js';
import { MODERATION_INPUT, isModerator, moderationInputOf, validateModeration } from './moderation-reports.js';

const key = z.string().regex(/^[\w-]{1,64}$/);
const requestId = z.string().regex(/^[a-f0-9]{64}$/);
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const REQUEST_HUMAN = z.object({ dedupe_key: key, visibility: z.enum(['private', 'project', 'moderators']),
  title: z.string().trim().min(1).max(120), question: z.string().trim().min(1).max(2000),
  context: z.string().trim().max(1000).default(''),
  attempted: z.string().trim().min(1).max(1000).optional(),
  blocker_title: z.string().trim().min(1).max(100).optional(),
  attempted_title: z.string().trim().min(1).max(100).optional(),
  selection_mode: z.enum(['single','multiple']).default('single'),
  suggested_options: z.array(z.string().trim().min(1).max(300)).max(3).refine(options => new Set(options).size === options.length, 'Suggested options must be distinct.').default([]), moderation: MODERATION_INPUT.optional() }).strict();
export const ANSWER_HUMAN = z.object({ expected_revision: z.number().int().positive(),
  client_request_id: key, body: z.string().trim().max(2000).default(''), option_index: z.number().int().min(0).max(2).optional(),
  option_indices: z.array(z.number().int().min(0).max(2)).max(3).refine(indices => new Set(indices).size === indices.length, 'Choose each option once.').optional(),
  custom_answer: z.string().trim().min(1).max(2000).optional() }).strict().refine(input => input.body.length + (input.custom_answer?.length ?? 0) <= 2000, 'Keep the answer and note within 2000 characters combined.');
export const ACKNOWLEDGE_HUMAN = z.object({ request_id: requestId, expected_revision: z.number().int().positive(), client_request_id: key }).strict();
export const RESOLVE_HUMAN = z.object({ request_id: requestId, expected_revision: z.number().int().positive(),
  client_request_id: key, summary: z.string().trim().min(1).max(1000) }).strict();
export const HUMAN_QUERY = z.object({ project_id: requestId.optional(), status: z.enum(['open','answered','resolved']).default('open'), cursor: z.string().max(1500).optional(), limit: z.coerce.number().int().min(1).max(100).optional() }).strict();
export const humanRequests = collection<HumanRequest>('humanRequests');
export const humanRequestVisibility = (profileId: string, moderator: boolean) => Filter.or(
  Filter.where('visibility', '==', 'project'),
  Filter.and(Filter.where('visibility', '==', 'private'), Filter.where('assigneeProfileId', '==', profileId)),
  ...(moderator ? [Filter.where('visibility', '==', 'moderators')] : []),
);
const operations = collection<{ fingerprint: string; request: HumanRequest }>('humanRequestOperations');
function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new Refusal('bad_input', parsed.error.issues[0]?.message ?? 'Some fields in this request are missing or not in the expected form.');
  return parsed.data;
}
function missing(): never { throw new Refusal('not_found', 'This request wasn’t found.'); }
async function personActive(tx: FirebaseFirestore.Transaction, profileId: string) {
  const p = (await tx.get(profiles.doc(profileId))).data();
  if (!p || p.removedAt !== null) throw new Refusal('unauthorized', 'Your MyLittleSwarm account is no longer active.');
}
export async function requestHuman(agentId: string, runId: string, raw: unknown, now: () => number) {
  const input = parse(REQUEST_HUMAN, raw), projectId = currentProjectId();
  if ((input.visibility === 'moderators') !== !!input.moderation) throw new Refusal('bad_input','Moderation reports require moderators visibility and structured subject/evidence.');
  // Shared decisions deduplicate across the project. Local permission needs remain agent-specific.
  const id = digest([projectId, input.visibility, input.visibility === 'project' ? 'project' : agentId, input.dedupe_key]);
  return db.runTransaction(async tx => {
    await assertRunInTransaction(tx, agentId, runId);
    const [agentDoc, project, prior, card] = await Promise.all([tx.get(agents().doc(agentId)), tx.get(projectDoc()), tx.get(humanRequests.doc(id)), tx.get(cardDoc(projectId))]);
    const agent = agentDoc.data()!, p = project.data()!;
    if (prior.exists) {
      const stored = prior.data()!;
      if ((input.visibility !== 'project' && stored.requesterProfileId !== agent.ownerProfileId) || stored.visibility !== input.visibility || stored.title !== input.title || stored.question !== input.question || stored.context !== input.context
        || stored.attempted !== input.attempted || stored.blockerTitle !== input.blocker_title || stored.attemptedTitle !== input.attempted_title || (stored.selectionMode ?? 'single') !== input.selection_mode || digest(stored.suggestedOptions ?? []) !== digest(input.suggested_options)
        || digest(moderationInputOf(stored.moderation) ?? null) !== digest(input.moderation ?? null)) {
        throw new Refusal('intent_conflict', 'This dedupe_key is already used for a different request. Read that request, or use a new key for a new need.');
      }
      return { request: stored, deduplicated: true, startsWork: false };
    }
    if (input.visibility !== 'moderators' && (!input.context || !input.attempted)) throw new Refusal('bad_input', 'Explain what required work is blocked in context and what you already tried in attempted. Ask only when human help is needed.');
    if (input.visibility === 'moderators' && (input.attempted || input.blocker_title || input.attempted_title || input.suggested_options.length || input.selection_mode !== 'single')) throw new Refusal('bad_input', 'Moderation reports use context and question for human review, not blocker options.');
    await assertProjectWritable(tx);
    const moderation = input.moderation ? await validateModeration(tx,input.moderation) : undefined;
    const at = now();
    const request: HumanRequest = { id, projectId, projectTitle: card.data()!.definition.title, agentId, agentName: agent.name,
      requesterProfileId: agent.ownerProfileId, assigneeProfileId: input.visibility === 'private' ? agent.ownerProfileId : p.ownerProfileId,
      visibility: input.visibility, title: input.title, question: input.question, context: input.context,
      status: 'open', revision: 1, createdAt: at, updatedAt: at, answer: null, resolution: null,
      ...(moderation ? { moderation } : { attempted: input.attempted!, suggestedOptions: input.suggested_options, selectionMode: input.selection_mode, ...(input.blocker_title ? {blockerTitle:input.blocker_title} : {}), ...(input.attempted_title ? {attemptedTitle:input.attempted_title} : {}) }) };
    tx.create(humanRequests.doc(id), request);
    return { request, deduplicated: false, startsWork: false };
  });
}

// One canonical record; indexes and cursors contain references, never a second copy of the question.
export async function readHumanRequests(profileId: string, raw: unknown): Promise<HumanRequestPage> {
  const query = parse(HUMAN_QUERY, raw);
  return listRequests({ profileId }, query);
}
export async function readAgentHumanRequests(agentId: string, runId: string, raw: unknown) {
  const input = parse(z.object({ scope: z.enum(['mine','project']).default('mine'), status: z.enum(['open','answered','resolved']).default('open'), cursor: z.string().max(1500).optional(), limit: z.number().int().min(1).max(100).optional() }).strict(), raw);
  return listRequests({ agentId, runId }, { ...input, project_id: currentProjectId() });
}
async function listRequests(actor: { profileId: string } | { agentId: string; runId: string }, input: { project_id?: string; scope?: 'mine'|'project'; status: HumanRequest['status']; cursor?: string; limit?: number }): Promise<HumanRequestPage> {
  const agent = 'agentId' in actor;
  const projectScope = agent ? input.scope === 'project' : input.project_id !== undefined;
  const inbox = agent ? (projectScope ? 'agent_project' : 'agent_mine') : (projectScope ? 'person_project' : 'person_assigned');
  const scope = [agent ? actor.agentId : actor.profileId, input.project_id ?? null, inbox, input.status];
  const cursor = input.cursor ? decodeCursor(input.cursor) : null;
  if (input.cursor && (!cursor || cursor.length !== 6 || scope.some((v,i) => cursor[i] !== v) || typeof cursor[4] !== 'number' || !requestId.safeParse(cursor[5]).success)) throw new Refusal('bad_input', 'Use the cursor returned for this list and filter.');
  return db.runTransaction(async tx => {
    if (agent) await assertRunInTransaction(tx, actor.agentId, actor.runId);
    else await personActive(tx, actor.profileId);
    const role = projectScope && !agent ? await inProject(input.project_id!, () => assertMembership(tx, actor.profileId)) : null;
    let query = humanRequests.where('status', '==', input.status);
    if (projectScope) {
      query = query.where('projectId','==', input.project_id);
      // Project members share decisions, never another participant's private requests.
      query = agent ? query.where('visibility','==','project') : query.where(humanRequestVisibility(actor.profileId, !!role && isModerator(role)));
    }
    else if (agent) query = query.where('projectId','==',input.project_id).where('agentId','==',actor.agentId);
    else query = query.where('assigneeProfileId','==',actor.profileId);
    query = query.orderBy('createdAt','desc').orderBy(FieldPath.documentId());
    if (cursor) query = query.startAfter(cursor[4], cursor[5]);
    const size = input.limit ?? 20, docs = (await tx.get(query.limit(size + 1))).docs, page = docs.slice(0,size);
    const items: HumanRequest[] = [];
    for (const doc of page) {
      const request = doc.data();
      if (!agent && !projectScope) {
        try {
          const role = await inProject(request.projectId, () => assertMembership(tx, actor.profileId));
          if (request.visibility === 'moderators' && !isModerator(role)) continue;
        }
        catch (error) { if (error instanceof Refusal && error.code === 'unauthorized') continue; throw error; }
      }
      items.push(request);
    }
    const last = page.at(-1)?.data();
    return { items, next: docs.length > size && last ? encodeCursor([...scope,last.createdAt,last.id]) : null };
  });
}

export async function answerHumanRequest(profileId: string, id: string, raw: unknown, now: () => number) {
  parse(requestId,id); const input = parse(ANSWER_HUMAN,raw);
  if (input.option_index !== undefined && (input.option_indices !== undefined || input.custom_answer !== undefined)) throw new Refusal('bad_input','Use option_indices with custom_answer, or the single option_index format, not both.');
  const indices = input.option_indices?.slice().sort((a,b)=>a-b) ?? (input.option_index === undefined ? [] : [input.option_index]);
  // beta.54 is an active consumer; keep its durable retry identity (OPE-253).
  const fingerprint = input.option_indices !== undefined || input.custom_answer !== undefined
    ? digest([id,input.expected_revision,'selections',indices,input.custom_answer ?? null,input.body])
    : digest(input.option_index === undefined ? [id,input.expected_revision,input.body] : [id,input.expected_revision,input.body,input.option_index]);
  return db.runTransaction(async tx => {
    const ref = humanRequests.doc(id), saved = (await tx.get(ref)).data();
    if (!saved) return missing();
    return inProject(saved.projectId, async () => {
      const role = await assertMembership(tx,profileId);
      if (saved.visibility === 'moderators' ? !isModerator(role) : saved.assigneeProfileId !== profileId) return missing();
      const op = operations.doc(digest([profileId,'answer',input.client_request_id]));
      const prior = (await tx.get(op)).data();
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new Refusal('intent_conflict','This request ID was already used with different details. Send the original request again, or use a new request ID.');
        return { request: prior.request, replayed: true };
      }
      await assertProjectWritable(tx);
      if (saved.revision !== input.expected_revision || saved.status !== 'open') throw new Refusal('intent_conflict','This request changed since you opened it. Reload it, then try again.');
      if (saved.moderation && (indices.length || input.custom_answer !== undefined)) throw new Refusal('bad_input','Moderation reports require a written review.');
      if (indices.some(index => saved.suggestedOptions?.[index] === undefined)) throw new Refusal('bad_input','Choose suggested options from this request.');
      if ((saved.selectionMode ?? 'single') === 'single' && indices.length + Number(input.custom_answer !== undefined) > 1) throw new Refusal('bad_input','This request allows one answer. Choose a suggestion or write your own.');
      const choices = indices.map(index => saved.suggestedOptions![index]);
      const body = [choices.join('\n'), input.custom_answer, input.body].filter(Boolean).join('\n\n');
      if (!body) throw new Refusal('bad_input','Choose an option or write an answer.');
      const selection = {
        ...(indices.length === 1 ? {optionIndex:indices[0]} : {}),
        ...(input.option_indices !== undefined ? {optionIndices:indices} : {}),
        ...(input.custom_answer !== undefined ? {customAnswer:input.custom_answer} : {}),
      };
      if (saved.visibility === 'moderators') {
        const at = now();
        const request: HumanRequest = {...saved,status:'resolved',revision:saved.revision+1,updatedAt:at,
          answer:{profileId,body,at,...selection},resolution:{body:input.body,at}};
        tx.set(ref,request);tx.create(op,{fingerprint,request});
        return {request,replayed:false};
      }
      const signalRef = workSignalDoc(saved.agentId);
      const [signalDoc, runDoc] = await Promise.all([tx.get(signalRef),tx.get(runs().doc(saved.agentId))]);
      const signal = await countedWorkSignal(tx,saved.agentId,signalDoc.data());
      if (signal.revision >= Number.MAX_SAFE_INTEGER || !Number.isSafeInteger(signal.runnableCount + signal.humanAnswerCount + 1)) throw new Refusal('intent_conflict','Something went wrong saving this. Try again in a moment; if it keeps happening, tell the MyLittleSwarm team.');
      const at = now();
      const request: HumanRequest = { ...saved, status:'answered', revision:saved.revision+1, updatedAt:at, answer:{profileId,body,at,...selection} };
      tx.set(ref,request); tx.create(op,{fingerprint,request});
      const next = { revision:signal.revision+1, runnable:true };
      tx.set(signalRef,{...signal,...next,humanAnswerCount:signal.humanAnswerCount+1});
      if (runDoc.exists) tx.update(runDoc.ref,{workSignal:next});
      return { request, replayed:false };
    });
  });
}
/** An explicit agent receipt, not inferred from a list/read and not a resolution or scheduling event. */
export async function acknowledgeHumanAnswer(agentId: string, runId: string, raw: unknown, now: () => number) {
  const input = parse(ACKNOWLEDGE_HUMAN,raw), fingerprint = digest(input);
  return db.runTransaction(async tx => {
    await assertRunInTransaction(tx,agentId,runId);
    const ref = humanRequests.doc(input.request_id), saved = (await tx.get(ref)).data();
    if (!saved || saved.projectId !== currentProjectId() || saved.agentId !== agentId) return missing();
    if (saved.moderation) throw new Refusal('forbidden','Only human reviewers handle moderation reports.');
    const op = operations.doc(digest([currentProjectId(),agentId,'acknowledge',input.client_request_id]));
    const prior = (await tx.get(op)).data();
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new Refusal('intent_conflict','This request ID was already used with different details. Retry the original acknowledgment.');
      return {request:prior.request,replayed:true};
    }
    await assertProjectWritable(tx);
    if (saved.revision !== input.expected_revision || saved.status !== 'answered' || !saved.answer || saved.answer.acknowledged) throw new Refusal('intent_conflict','Read the current answered request before acknowledging it.');
    if (saved.revision >= Number.MAX_SAFE_INTEGER) throw new Refusal('intent_conflict','This request cannot accept another revision.');
    const at = now();
    const request: HumanRequest = {...saved,revision:saved.revision+1,updatedAt:at,
      answer:{...saved.answer,acknowledged:{agentId,runId,at}}};
    tx.set(ref,request);tx.create(op,{fingerprint,request});
    return {request,replayed:false};
  });
}

export async function resolveHumanRequest(agentId: string, runId: string, raw: unknown, now: () => number) {
  const input = parse(RESOLVE_HUMAN,raw), fingerprint = digest(input);
  return db.runTransaction(async tx => {
    await assertRunInTransaction(tx,agentId,runId);
    const ref = humanRequests.doc(input.request_id), saved = (await tx.get(ref)).data();
    if (!saved || saved.projectId !== currentProjectId() || saved.agentId !== agentId) return missing();
    if (saved.visibility === 'moderators') throw new Refusal('forbidden','Only a human project reviewer resolves moderation reports.');
    const op = operations.doc(digest([currentProjectId(),agentId,'resolve',input.client_request_id]));
    const prior = (await tx.get(op)).data();
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new Refusal('intent_conflict','This request ID was already used with different details. Send the original request again, or use a new request ID.');
      return {request:prior.request,replayed:true};
    }
    await assertProjectWritable(tx);
    if (saved.revision !== input.expected_revision || saved.status === 'resolved') throw new Refusal('intent_conflict','This request changed. Read it again, then resolve it.');
    const signalRef = workSignalDoc(agentId), signal = await countedWorkSignal(tx,agentId,(await tx.get(signalRef)).data());
    if (signal.revision >= Number.MAX_SAFE_INTEGER) throw new Refusal('intent_conflict','Something went wrong saving this. Try again in a moment; if it keeps happening, tell the MyLittleSwarm team.');
    const humanAnswerCount = signal.humanAnswerCount - Number(saved.status === 'answered');
    if (humanAnswerCount < 0) throw new Refusal('intent_conflict','Something went wrong saving this. Try again in a moment; if it keeps happening, tell the MyLittleSwarm team.');
    const at = now(), request: HumanRequest = {...saved,status:'resolved',revision:saved.revision+1,updatedAt:at,resolution:{body:input.summary,at}};
    const next = {revision:signal.revision+1,runnable:signal.runnableCount+humanAnswerCount>0};
    tx.set(ref,request); tx.create(op,{fingerprint,request});
    tx.set(signalRef,{...signal,...next,humanAnswerCount}); tx.update(runs().doc(agentId),{workSignal:next});
    return {request,replayed:false};
  });
}

export function humanRequestWithSource(request: HumanRequest) {
  const agent={type:'agent' as const,agentId:request.agentId,agentName:request.agentName};
  return {...request,
    ...(request.attempted ? {attempted:untrusted(agent,request.attempted)} : {}),
    ...(request.blockerTitle ? {blockerTitle:untrusted(agent,request.blockerTitle)} : {}),
    ...(request.attemptedTitle ? {attemptedTitle:untrusted(agent,request.attemptedTitle)} : {}),
    ...(request.suggestedOptions ? {suggestedOptions:request.suggestedOptions.map(option=>untrusted(agent,option))} : {}),
    title:untrusted(agent,request.title),question:untrusted(agent,request.question),context:untrusted(agent,request.context),
    answer:request.answer ? {...request.answer,...(request.answer.customAnswer !== undefined ? {customAnswer:untrusted({type:'person',personId:request.answer.profileId},request.answer.customAnswer)} : {}),body:untrusted({type:'person',personId:request.answer.profileId},request.answer.body)}:null,
    resolution:request.resolution ? {...request.resolution,body:untrusted(request.moderation && request.answer ? {type:'person',personId:request.answer.profileId} : agent,request.resolution.body)}:null,
    ...(request.moderation ? {moderation:untrusted(agent,request.moderation)} : {})};
}
