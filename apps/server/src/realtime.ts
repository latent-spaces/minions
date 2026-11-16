import express from 'express';
import { FieldPath, type DocumentReference, type Timestamp, type Query } from './firestore.js';
import { personFromIdToken } from './auth.js';
import { bearerToken } from './bearer.js';
import { db, inProject } from './firestore.js';
import { Refusal, sendRefusal } from './errors.js';
import { assertMembership, validProjectId, type ProjectRole } from './projects/access.js';
import { isModerator } from './projects/moderation-reports.js';
import { createSharedWatches } from './projects/project-control.js';
import { humanRequests, humanRequestVisibility } from './projects/human-requests.js';
import { openRealtimeStream, type RealtimeTopic } from './realtime-stream.js';
import { requestLimits } from './request-state.js';
import { boundedRealtimeChecks } from './realtime-checks.js';
import { NATIVE_TEAM_PROGRESS_SHARDS } from './projects/native-teams.js';

type Source = { path: string; filters?: [string, string | null][]; order?: string; nameDescending?: boolean; limit: number; projectNeeds?: { profile: string; moderator: boolean }; accountProfile?: string };
// Account inbox queries span projects. As in the readers, assignment alone is
// insufficient: even activity timing requires current membership/moderator access.
type AccountChange = { ref: DocumentReference; projectId: unknown; visibility: unknown; removed: boolean; updateTime: Timestamp };
async function visibleAccountChange(profile: string, changes: AccountChange[]) {
  return db.runTransaction(async tx => {
    const roles = new Map<string, ProjectRole | null>();
    for (const change of changes) {
      const project = change.projectId;
      if (!validProjectId(project)) continue;
      if (!roles.has(project)) {
        try { roles.set(project, await inProject(project, () => assertMembership(tx, profile))); }
        catch (error) { if (error instanceof Refusal && error.code === 'unauthorized') roles.set(project, null); else throw error; }
      }
      const role = roles.get(project);
      if (!role || change.visibility === 'moderators' && !isModerator(role)) continue;
      // A hidden insertion can evict an unchanged visible row from a limited
      // query. That eviction must not reveal the hidden insertion's timing.
      if (change.removed) {
        const current = await tx.get(change.ref);
        if (current.exists && current.updateTime?.isEqual(change.updateTime)) continue;
      }
      return true;
    }
    return false;
  });
}
// One Firestore target per query per replica, shared by all local subscribers.
// Only bounded current windows are watched; older history is reconciled by reads.
const watches = createSharedWatches<number>((key, next, fail) => {
  const source: Source = JSON.parse(key);
  let query: Query = db.collection(source.path);
  for (const [field, value] of source.filters ?? []) query = query.where(field, '==', value);
  if (source.projectNeeds) query = query.where(humanRequestVisibility(source.projectNeeds.profile, source.projectNeeds.moderator));
  if (source.order) query = query.orderBy(source.order, 'desc').orderBy(FieldPath.documentId(), source.nameDescending ? 'desc' : 'asc');
  let revision = 0, live = true, previousReadTime: Timestamp | undefined;
  // Keep a genuine write even if later window churn queues an unchanged removal
  // of that same row before its authorization check runs.
  const checks = boundedRealtimeChecks<AccountChange>(change => `${change.ref.path}:${change.removed ? 'removed' : 'written'}`,
    changes => visibleAccountChange(source.accountProfile!, changes), () => next(++revision), fail);
  const stop = query.limit(source.limit).onSnapshot(snapshot => {
    if (!live) return;
    if (!source.accountProfile) { next(++revision); return; }
    const before = previousReadTime; previousReadTime = snapshot.readTime;
    // A slow first snapshot may follow the stream's initial API refresh. Always
    // signal source readiness, regardless of its contents, to close that gap.
    // Later additions committed before the previous snapshot are unchanged
    // backfill rows, not activity (a hidden deletion can move them into view).
    if (!before) { next(++revision); return; }
    checks.add(snapshot.docChanges().filter(change => change.type !== 'added' || change.doc.updateTime.seconds > before.seconds ||
      change.doc.updateTime.seconds === before.seconds && change.doc.updateTime.nanoseconds > before.nanoseconds)
      .map(change => ({ ref: change.doc.ref, projectId: change.doc.data().projectId,
      visibility: change.doc.data().visibility, removed: change.type === 'removed', updateTime: change.doc.updateTime })));
  }, error => { if (live) fail(error); });
  return () => { live = false; checks.close(); stop(); };
}, 30000, 100);

export function realtimeRoutes() {
  const router = express.Router(), active = new Map<string, number>();
  const admission = requestLimits.limiter(() => 'realtime', 30, 60000);
  let total = 0;
  router.get('/', (req, res) => { void (async () => {
    const token = bearerToken(req.headers.authorization);
    if (!token) throw new Refusal('unauthorized', 'Sign in to follow updates.');
    const person = await personFromIdToken(token);
    const project = req.query.project_id;
    const requestedTopics = req.query.topics;
    const defaults: RealtimeTopic[] = project ? ['conversations', 'agents', 'needs-you'] : ['needs-you'];
    const allowed = new Set<RealtimeTopic>(project ? [...defaults, 'teams'] : defaults);
    if (Object.keys(req.query).some(key => !['project_id', 'topics'].includes(key)) || project !== undefined && !validProjectId(project)
      || requestedTopics !== undefined && (typeof requestedTopics !== 'string' || !requestedTopics.length
        || requestedTopics.split(',').some(topic => !allowed.has(topic as RealtimeTopic)))) throw new Refusal('bad_input', 'Choose a valid project and update topics.');
    // Explicit topic subscriptions let already-open clients retain their known
    // event vocabulary while newer clients follow additional project features.
    const topics = requestedTopics === undefined ? defaults : [...new Set((requestedTopics as string).split(','))] as RealtimeTopic[];
    if (req.get('X-Minions-Profile-Id') && req.get('X-Minions-Profile-Id') !== person.id) throw new Refusal('unauthorized', 'Your signed-in account changed.');
    let role = project ? await inProject(project, () => db.runTransaction(tx => assertMembership(tx, person.id))) : null;
    const retry = admission(person.id, Date.now());
    if (retry || (active.get(person.id) ?? 0) >= 8 || total >= 256) throw new Refusal('rate_limited', 'Updates will reconnect shortly.', Math.max(5, Math.ceil(retry / 1000)));
    if (res.destroyed) return;
    active.set(person.id, (active.get(person.id) ?? 0) + 1); total++;
    res.once('close', () => { total--; const count = (active.get(person.id) ?? 1) - 1; if (count) active.set(person.id, count); else active.delete(person.id); });
    const sources: Record<RealtimeTopic, Source[]> = { conversations: [], agents: [], 'needs-you': [], teams: [] };
    if (project) {
      sources.conversations = ['conversationEntries', 'humanChat'].map(name => ({ path: `projects/${project}/${name}`, order: 'createdAt', nameDescending: true, limit: 50 }));
      // Existing bounded revision shards cover canonical status changes without
      // opening a listener for every agent or loading historical run records.
      sources.conversations.push({ path: `projects/${project}/chatReactions`, order: 'updatedAt', nameDescending: true, limit: 1 });
      sources.agents = [{ path: `projects/${project}/currentStateProgress`, limit: 17 }];
      sources.teams = [{ path: `projects/${project}/nativeTeamProgress`, limit: NATIVE_TEAM_PROGRESS_SHARDS }];
    }
    sources['needs-you'] = ['open', 'answered', 'resolved'].map(status => ({ path: humanRequests.path,
      filters: [[project ? 'projectId' : 'assigneeProfileId', project ?? person.id], ['status', status]], order: 'createdAt', limit: 21,
      ...(project ? { projectNeeds: { profile: person.id, moderator: role === 'owner' } } : {}),
      ...(!project ? { accountProfile: person.id } : {}),
    }));
    if (!project) sources['needs-you'].push({ path: `profiles/${person.id}/notifications`, filters: [['readAt', null]], order: 'createdAt', nameDescending: true, limit: 21, accountProfile: person.id });
    openRealtimeStream(res, topics, async () => {
      if ((await personFromIdToken(token)).id !== person.id) throw new Refusal('unauthorized', 'Your signed-in account changed.');
      if (project) {
        const current = await inProject(project, () => db.runTransaction(tx => assertMembership(tx, person.id)));
        // Reopen with the new visibility filter after a role change.
        if (current !== role) throw new Refusal('unauthorized', 'Project access changed.');
        role = current;
      }
    }, (topic, changed, failed) => {
      const stops = sources[topic].map(source => watches.join(JSON.stringify(source), (_value, error) => error ? failed() : changed()));
      return () => { for (const stop of stops) stop(); };
    });
  })().catch(error => {
    if (res.headersSent) { res.end(); return; }
    if (error instanceof Refusal) {
      sendRefusal(res, error);
    } else { console.error('Realtime subscription failed.', error); res.status(503).json({ error: 'unavailable', message: 'Updates will reconnect shortly.' }); }
  }); });
  return router;
}
