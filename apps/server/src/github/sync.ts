import { runtimeOf } from '../projects/records.js';
// One leased page per invocation. A private scheduler/worker must invoke this independently;
// discovery calls never invoke GitHub or advance synchronization.
import { db, inProject, projectDoc } from '../firestore.js';
import { Refusal } from '../errors.js';
import { githubNumberIdentity } from './resource-identity.js';
import { z } from 'zod';
import { githubContext, syncState, RESOURCES, type GitHubResource, type GitHubSync } from './context.js';
import { observations, observation, mergeObservation } from './work.js';
import { GitHubReadFailure, GITHUB_PAGE_SIZE, type ReadRepositoryPage, type RepositoryPage } from './reader.js';

export { syncState } from './context.js';
const LEASE_MS = 30000, CYCLE_MS = 60000, FULL_INTERVAL_MS = 24 * 60 * 60 * 1000;
const OVERLAP_MS = 60000, INVALID_RESPONSE_ATTEMPTS = 3;
// Operator choice only: clears a block (for example one left by the earlier first-malformed-reply rule) so the next run reads again.
export async function unblockRepository(projectId: string, resource: GitHubResource, binding: { repositoryId: number }) {
  if (!RESOURCES.includes(resource) || !Number.isSafeInteger(binding.repositoryId) || binding.repositoryId < 1) throw new Error('Invalid GitHub repository binding.');
  return inProject(projectId, () => db.runTransaction(async tx => {
    const [project, current] = await Promise.all([tx.get(projectDoc()), tx.get(syncState(resource))]);
    if (!runtimeOf(project.data())) throw new Refusal('not_found', 'This project has no GitHub repository yet. Ask the owner to add one in Settings.');
    const repoUrl = githubNumberIdentity(runtimeOf(project.data())!.repoUrl, 1).repoUrl, state = current.data();
    if (!state?.blocked || state.repoUrl !== repoUrl || state.repositoryId !== binding.repositoryId) return { outcome: 'not_blocked' as const };
    tx.set(syncState(resource), { ...state, blocked: false, leaseUntil: 0, readyAt: Date.now(), consecutiveFailures: 0, lastFailure: null, invalidResponses: 0 });
    return { outcome: 'unblocked' as const, lastFailure: state.lastFailure };
  }));
}
export async function reconcileRepository(projectId: string, resource: GitHubResource, binding: { repositoryId: number }, read: ReadRepositoryPage) {
  if (!RESOURCES.includes(resource) || !Number.isSafeInteger(binding.repositoryId) || binding.repositoryId < 1) throw new Error('Invalid GitHub repository binding.');
  return inProject(projectId, async () => {
    const leased = await db.runTransaction(async tx => {
      const [project, current, contextDoc] = await Promise.all([tx.get(projectDoc()), tx.get(syncState(resource)), tx.get(githubContext())]);
      if (!runtimeOf(project.data())) throw new Refusal('not_found', 'This project has no GitHub repository yet. Ask the owner to add one in Settings.');
      const repoUrl = githubNumberIdentity(runtimeOf(project.data())!.repoUrl, 1).repoUrl, at = Date.now(), context = contextDoc.data();
      if (context?.repoUrl === repoUrl && context.repositoryId !== binding.repositoryId) throw new Refusal('forbidden', 'The project’s GitHub repository changed. Ask the Minions team to reconnect it.');
      const stored = current.data();
      const prior = stored?.repoUrl === repoUrl && stored.repositoryId === binding.repositoryId ? stored : undefined;
      if (prior?.blocked) return { outcome: 'blocked' as const };
      if (prior && (prior.readyAt > at || prior.leaseUntil > at)) return { outcome: 'deferred' as const, readyAt: Math.max(prior.readyAt, prior.leaseUntil) };
      const state: GitHubSync = prior ?? { repoUrl, repositoryId: binding.repositoryId, generation: 0, leaseUntil: 0, readyAt: at,
        blocked: false, page: 1, since: null, cycleStartedAt: null, cycleWatermarkAt: null, cycleClockKnown: true, lastPassAt: null, lastFullPassAt: null, passes: 0,
        consecutiveFailures: 0, lastFailure: null, invalidResponses: 0, pages: 0, apiRequests: 0, responseBytes: 0, objectsObserved: 0 };
      if (!Number.isSafeInteger(state.generation) || state.generation < 0 || state.generation >= Number.MAX_SAFE_INTEGER) throw new Refusal('intent_conflict', 'Something went wrong saving this. Try again in a moment; if it keeps happening, tell the Minions team.');
      const newCycle = state.cycleStartedAt === null;
      const since = resource !== 'issues' ? null : newCycle && (state.lastFullPassAt === null || at - state.lastFullPassAt >= FULL_INTERVAL_MS) ? null : state.since;
      const lease = { ...state, since, cycleStartedAt: state.cycleStartedAt ?? at,
        cycleWatermarkAt: newCycle ? null : state.cycleWatermarkAt, cycleClockKnown: newCycle ? true : state.cycleClockKnown,
        generation: state.generation + 1, leaseUntil: at + LEASE_MS };
      if (!context || context.repoUrl !== repoUrl) tx.set(githubContext(), { repoUrl, repositoryId: binding.repositoryId });
      tx.set(syncState(resource), lease);
      return { outcome: 'leased' as const, state: lease };
    });
    if (leased.outcome !== 'leased') return leased;
    const lease = leased.state;
    let result: RepositoryPage | undefined;
    try {
      result = await read({ resource, repoUrl: lease.repoUrl, repositoryId: lease.repositoryId, page: lease.page, since: lease.since });
      if (!Array.isArray(result.items) || result.items.length > GITHUB_PAGE_SIZE || !Number.isInteger(result.requests) || result.requests < 0 || result.requests > 2
        || !Number.isInteger(result.bytes) || result.bytes < 0 || result.bytes > 4 * 1024 * 1024
        || result.sourceAt !== null && (!Number.isSafeInteger(result.sourceAt) || result.sourceAt < 0)
        || typeof result.hasNext !== 'boolean' || result.deferUntil !== null && (!Number.isSafeInteger(result.deferUntil) || result.deferUntil < 0)) throw new GitHubReadFailure('invalid_response');
      const at = Date.now();
      const normalized = result.items.filter(item => resource !== 'issues' || !(item && typeof item === 'object' && 'pull_request' in item))
        .map(item => observation(resource, lease.repoUrl, lease.repositoryId, item, at));
      if (new Set(normalized.map(row => row.number)).size !== normalized.length) throw new GitHubReadFailure('invalid_response');
      const pageResult = result;
      return await db.runTransaction(async tx => {
        const [project, current, contextDoc] = await Promise.all([tx.get(projectDoc()), tx.get(syncState(resource)), tx.get(githubContext())]);
        const state = current.data(), context = contextDoc.data(), commitAt = Date.now();
        if (!state || state.generation !== lease.generation || state.leaseUntil <= commitAt || state.repoUrl !== lease.repoUrl
          || state.repositoryId !== lease.repositoryId || !runtimeOf(project.data()) || githubNumberIdentity(runtimeOf(project.data())!.repoUrl, 1).repoUrl !== lease.repoUrl
          || context?.repositoryId !== lease.repositoryId || context.repoUrl !== lease.repoUrl) return { outcome: 'stale' as const };
        const refs = normalized.map(row => observations(resource).doc(githubNumberIdentity(row.repoUrl, row.number).key));
        const previous = refs.length ? await tx.getAll(...refs) : [];
        for (let i = 0; i < refs.length; i++) {
          const update = mergeObservation(previous[i].data(), normalized[i]);
          if (update.write) tx.set(refs[i], update.write);
        }
        const complete = !pageResult.hasNext;
        const clockKnown = state.cycleClockKnown && pageResult.sourceAt !== null;
        const watermark = pageResult.sourceAt === null ? state.cycleWatermarkAt
          : Math.min(state.cycleWatermarkAt ?? pageResult.sourceAt, pageResult.sourceAt);
        const next = { ...state, leaseUntil: 0, readyAt: Math.max(commitAt + (complete ? CYCLE_MS : 1000), pageResult.deferUntil ?? 0),
          page: complete ? 1 : state.page + 1, since: resource === 'issues' && complete && clockKnown && watermark !== null ? Math.max(0, watermark - OVERLAP_MS) : state.since,
          cycleStartedAt: complete ? null : state.cycleStartedAt, cycleWatermarkAt: complete ? null : watermark,
          cycleClockKnown: complete ? true : clockKnown, lastPassAt: complete ? commitAt : state.lastPassAt,
          lastFullPassAt: complete && state.since === null ? commitAt : state.lastFullPassAt, passes: state.passes + Number(complete),
          consecutiveFailures: 0, lastFailure: null, invalidResponses: 0, pages: state.pages + 1, apiRequests: state.apiRequests + pageResult.requests,
          responseBytes: state.responseBytes + pageResult.bytes, objectsObserved: state.objectsObserved + normalized.length };
        tx.set(syncState(resource), next);
        return { outcome: complete ? 'pass_observed' as const : 'page_applied' as const, page: state.page,
          resource, objects: normalized.length, readyAt: next.readyAt, apiRequests: pageResult.requests, responseBytes: pageResult.bytes };
      });
    } catch (error) {
      // Only numeric counters and finite codes persist. Never retain token/error body/payload.
      const failure = error instanceof GitHubReadFailure ? error : new GitHubReadFailure(error instanceof z.ZodError ? 'invalid_response' : 'unavailable');
      return db.runTransaction(async tx => {
        const [current, project, contextDoc] = await Promise.all([tx.get(syncState(resource)), tx.get(projectDoc()), tx.get(githubContext())]);
        const state = current.data(), at = Date.now(), context = contextDoc.data();
        if (!state || state.generation !== lease.generation || state.leaseUntil <= at || !runtimeOf(project.data())
          || githubNumberIdentity(runtimeOf(project.data())!.repoUrl, 1).repoUrl !== lease.repoUrl || context?.repositoryId !== lease.repositoryId
          || context.repoUrl !== lease.repoUrl) return { outcome: 'stale' as const };
        const failures = state.consecutiveFailures + 1;
        // A malformed reply can be one bad response: retry it on the schedule, and block after three in a row (owner selection, 30 October 2026).
        const invalidResponses = failure.code !== 'invalid_response' ? 0
          : (state.invalidResponses ?? Number(state.lastFailure === 'invalid_response')) + 1;
        const blocked = failures >= 8 || invalidResponses >= INVALID_RESPONSE_ATTEMPTS
          || ['access_denied', 'repository_changed', 'response_too_large'].includes(failure.code);
        const readyAt = Math.max(at + Math.min(60 * 60 * 1000, 60000 * 2 ** (failures - 1)), failure.retryAt ?? 0);
        tx.set(syncState(resource), { ...state, leaseUntil: 0, blocked, consecutiveFailures: failures, lastFailure: failure.code, invalidResponses, readyAt,
          apiRequests: state.apiRequests + (result?.requests ?? failure.requests), responseBytes: state.responseBytes + (result?.bytes ?? failure.bytes) });
        return { outcome: blocked ? 'blocked' as const : 'retry' as const, failure: failure.code, readyAt };
      });
    }
  });
}
