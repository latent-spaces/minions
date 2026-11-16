import { personaChoice } from '@minions/contracts';
import type { CommunicationAgent, CommunicationAgentState, CommunicationAgents } from '@minions/contracts';
import type { DocumentData, DocumentReference, DocumentSnapshot, Query } from '../firestore.js';
import { agents, currentProjectId, db, type Agent } from '../firestore.js';
import { Refusal } from '../errors.js';
import { V2_LIMITS } from '../config.js';
import { activeRecipientOperators, connectionAllowed } from '../projects/access.js';
import { humanRequests } from '../projects/human-requests.js';
import { presence, type Presence, type Run } from '../v2/records.js';
import { queuedStart, webAgentStarts } from '../owner/web-agent-starts.js';
import { type WorkerSummary } from '../projects/worker-sessions.js';
import { projects } from '../projects/records.js';
import { sourcesFromStatusDoc, statusRunComplete, type AgentStatusDoc } from './agent-status-doc.js';
import { requireCurrentStateCutover } from './current-state-cutover.js';
import { agentGroup } from '../v2/agent-group.js';

async function batch<T extends DocumentData>(refs: DocumentReference<T>[]): Promise<DocumentSnapshot<T>[]> {
  return refs.length ? await db.getAll(...refs) as DocumentSnapshot<T>[] : [];
}

// Firestore expands `in` filters into at most 30 disjunctions, and at most 100 filters plus orders in total.
// An `in` over agents next to a two-value `in` therefore takes floor(99 / (2 × fields)) agents per query.
const idsPerQuery = (fields: number) => Math.floor(99 / (2 * fields));
export const ROWS_PER_QUERY = 60;
// The agents among ids with at least one matching row, in one query per chunk of agents rather than one per agent.
// A query that fills its limit may have hidden rows, so agents it did not show are asked one by one.
async function agentsWithRows(ids: string[], fields: number, rowsFor: (ids: string[]) => Query): Promise<Set<string>> {
  const found = new Set<string>(), size = idsPerQuery(fields);
  await Promise.all(Array.from({ length: Math.ceil(ids.length / size) }, async (_, i) => {
    const chunk = ids.slice(i * size, (i + 1) * size);
    const rows = await rowsFor(chunk).select('agentId').limit(ROWS_PER_QUERY).get();
    rows.docs.forEach(row => found.add(row.get('agentId')));
    if (rows.size < ROWS_PER_QUERY) return;
    await Promise.all(chunk.filter(id => !found.has(id)).map(async id => {
      if (!(await rowsFor([id]).select('agentId').limit(1).get()).empty) found.add(id);
    }));
  }));
  return found;
}

// One screen-sized batch. No history, private steering text, run IDs or credentials
// leave this projection. viewRoutes authenticates project membership on every read.
export async function communicationAgents(query: Record<string, unknown>, profileId: string, now: number): Promise<CommunicationAgents> {
  const ids = typeof query.ids === 'string' ? query.ids.split(',') : [];
  if (Object.keys(query).some(key => key !== 'ids') || !ids.length || ids.length > 60
    || new Set(ids).size !== ids.length || ids.some(id => !/^[A-Za-z0-9_-]{1,200}$/.test(id)))
    throw new Refusal('bad_input', 'Choose up to 60 different agents from this project.');
  const queuedIds = ids.filter(id => id.startsWith('queued-'));
  const [docs, queued] = await Promise.all([batch(ids.filter(id => !id.startsWith('queued-')).map(id => agents().doc(id))), Promise.all(queuedIds.map(id => queuedStart(id, now)))]);
  // An agent waiting for an offline computer to create it.
  const waiting = queued.filter(r => r !== null).map((r): CommunicationAgent => ({ id: r.id, name: r.name, mine: r.profileId === profileId, state: 'waiting',
    personaChoice: null, focus: null, reportedAt: null, lastContactAt: null, freshUntil: null }));
  return { serverTime: now, agents: [...waiting, ...await readCanonicalAgentStates(docs.filter(doc => doc.exists), profileId, now)] };
}

// The one status of any agent, for every surface that shows one: the map, the directory, the agent's page and MCP
// find_agents. Every surface reads the same canonical sources (canonicalStatusSources) and derives with the same pure function
// (deriveAgentState), so they cannot disagree about an agent observed at the same moment.
export type AgentStateSources = {
  id: string; agent: Agent; allowed: boolean; run?: Run; contact?: Presence; worker?: WorkerSummary;
  queued: boolean; needsYou: boolean; pause?: { revision: number; requestedAt: number };
  // The newest Firestore update time among the agent's own source documents: a per-agent revision for ordering
  // changes without a wall clock (current-state contract). Not stored.
  sourceRevision: number;
};
export type DerivedAgentState = Pick<CommunicationAgent, 'state' | 'projectPause' | 'reportedAt' | 'lastContactAt' | 'freshUntil'>;

export const TALKING_MS = 90_000;
export function deriveAgentState(s: AgentStateSources, now: number): DerivedAgentState {
  const fresh = (at: number | undefined) => typeof at === 'number' && at <= now && at > now - V2_LIMITS.runActiveSeconds * 1000;
  const { agent, run, contact, pause } = s;
  const seen = run && contact?.runId === run.runId ? contact : undefined;
  const worker = run && s.worker?.runId === run.runId ? s.worker : undefined;
  const contactTimes = [seen?.lastContactAt, worker?.lastContactAt].filter((at): at is number => typeof at === 'number' && at <= now);
  let state: CommunicationAgentState = 'unknown';
  let observedAt = contactTimes.length ? Math.max(...contactTimes) : null;
  let freshUntil: number | null = null;
  if (agent.revokedAt !== null || !s.allowed) state = 'revoked';
  else if (s.needsYou) state = 'needs_you';
  else if (s.queued) state = 'waiting';
  else if (run?.endedAt != null) state = 'stopped';
  else if (worker && ['stopped', 'completed'].includes(worker.phase)) state = worker.phase as 'stopped' | 'completed';
  else if (worker && fresh(worker.lastContactAt)) {
    observedAt = worker.lastContactAt; freshUntil = worker.lastContactAt + V2_LIMITS.runActiveSeconds * 1000;
    // A worker between turns reports 'waiting'; that is Idle (owner feedback, 20 October 2026). The 'waiting' state
    // (hourglass) is for a start that is queued or still starting.
    state = worker.phase === 'waiting' ? 'idle' : worker.phase;
  } else if (seen && fresh(seen.lastContactAt)) {
    freshUntil = seen.lastContactAt + V2_LIMITS.runActiveSeconds * 1000;
    state = ({ turn: 'working', idle: 'idle', backoff: 'waiting', paused: 'paused', stopping: 'stopped' } as const)[seen.phase] ?? 'unknown';
  } else if (seen || worker) state = 'offline';
  // Between turns right after sending a message, an agent is in a discussion, not idle (owner, 14 November 2026).
  if (state === 'idle' && (agent.recentSends ?? []).some(at => at <= now && now - at < TALKING_MS)) state = 'talking';
  let projectPause: CommunicationAgent['projectPause'];
  if (pause && run?.endedAt === null && !['revoked','stopped','completed'].includes(state) && !s.queued) {
    const confirmed = worker?.phase === 'paused' && worker.projectPauseRevision === pause.revision && fresh(worker.lastContactAt);
    const controlContactAt = worker?.lastContactAt ?? observedAt;
    projectPause = { ...pause, confirmedAt: confirmed ? worker!.lastContactAt : null, externalChat: run.mode === 'current_chat' };
    // Pause lets the turn finish (owner decision, 9 November 2026): a worker in contact and still in its turn is pausing
    // for as long as the turn takes. The 30 s limit applies only to a worker that is not in a turn.
    const finishingTurn = worker?.phase === 'working' && fresh(worker.lastContactAt);
    state = confirmed ? 'paused' : projectPause.externalChat || !fresh(controlContactAt ?? undefined) || (!finishingTurn && now - pause.requestedAt >= 30000) ? 'pause_unconfirmed' : 'pausing';
    // Pause confirmation expires on the worker's contact, not a different presence writer.
    freshUntil = confirmed || finishingTurn ? worker!.lastContactAt + V2_LIMITS.runActiveSeconds * 1000 : Math.min(
      (controlContactAt ?? now) + V2_LIMITS.runActiveSeconds * 1000, pause.requestedAt + 30000);
  }
  return { state, ...(projectPause ? { projectPause } : {}), reportedAt: observedAt,
    lastContactAt: contactTimes.length ? Math.max(...contactTimes) : null, freshUntil };
}

// Canonical request-time reader for MCP, directory, public and selected-id surfaces. No listener or legacy
// run/worker reconstruction is involved. Historical incomplete records need no migration (owner, 27 Oct).
export const statusSourceReads = { canonicalRows: 0, incompleteRows: 0, admissionReads: 0 };
export function resetStatusSourceReads() {
  statusSourceReads.canonicalRows = 0; statusSourceReads.incompleteRows = 0; statusSourceReads.admissionReads = 0;
}
// Only this helper can construct a prefetched canonical input. Admission and
// contacts share one snapshot, so callers cannot hand the mapper pre-cutover data.
const READY_CONTACTS = Symbol('admitted canonical contacts');
export type ReadyCanonicalContacts = { readonly docs: DocumentSnapshot<Presence>[]; readonly [READY_CONTACTS]: true };
export async function readReadyCanonicalContacts(ids: string[]): Promise<ReadyCanonicalContacts> {
  const docs = ids.length ? await db.runTransaction(async tx => {
    statusSourceReads.admissionReads++;
    await requireCurrentStateCutover(tx);
    return tx.getAll(...ids.map(id => presence().doc(id)));
  }, { readOnly: true }) : [];
  return { docs: docs as DocumentSnapshot<Presence>[], [READY_CONTACTS]: true };
}
export async function canonicalStatusSources(found: DocumentSnapshot<Agent>[], profileId: string | null,
  knownOperators?: Awaited<ReturnType<typeof activeRecipientOperators>>,
  knownContacts?: ReadyCanonicalContacts): Promise<AgentStateSources[]> {
  if (knownContacts && (!knownContacts[READY_CONTACTS] || knownContacts.docs.length !== found.length || knownContacts.docs.some((doc, i) => doc.id !== found[i].id)))
    throw new Error('canonicalStatusSources: status documents must match found, in order.');
  if (!found.length) return [];
  const [admitted, operators, project] = await Promise.all([
    knownContacts ?? readReadyCanonicalContacts(found.map(doc => doc.id)),
    knownOperators && !profileId ? knownOperators
      : db.runTransaction(tx => activeRecipientOperators(tx, [...found.map(doc => doc.data()!.ownerProfileId), ...(profileId ? [profileId] : [])]), { readOnly: true }),
    projects.doc(currentProjectId()).get(),
  ]);
  const contacts = admitted.docs;
  const covered = found.map((doc, i) => {
    const status = contacts[i].data();
    if (statusRunComplete(status)) {
      statusSourceReads.canonicalRows++;
      return sourcesFromStatusDoc(doc.id, { ...status, agent: agentGroup(doc.data()!) } as AgentStatusDoc,
        { allowed: () => connectionAllowed(doc.data()!, operators) });
    }
    statusSourceReads.incompleteRows++;
    // Keep authority/identity from the agent document; no run/contact/worker observation is invented.
    return null;
  });
  const pause = project.data()?.execution.paused && project.data()?.execution.completedAt === null ? project.data()?.execution.pauseRequest : undefined;
  // An agent added to wait for the project or its computer is Waiting, whichever way it was added.
  const byOwner = new Map<string, string[]>();
  for (const doc of found) byOwner.set(doc.data()!.ownerProfileId, [...byOwner.get(doc.data()!.ownerProfileId) ?? [], doc.id]);
  // Requests can be assigned only to the agent participant or project owner.
  // Most viewers need no private-request query for another participant's agent.
  const askable = !profileId ? [] : found.filter(doc => doc.data()!.ownerProfileId === profileId || operators.get(profileId)?.role === 'owner').map(doc => doc.id);
  const [waitingSets, needsYouIds] = await Promise.all([
    Promise.all([...byOwner].map(([owner, ids]) => agentsWithRows(ids, 4, chunk => webAgentStarts.where('profileId', '==', owner)
      .where('projectId', '==', currentProjectId()).where('agentId', 'in', chunk).where('state', 'in', ['pending', 'accepted'])))),
    // Existence only, never another person's private request; selected rows carry only agentId.
    agentsWithRows(askable, 5, chunk => humanRequests.where('projectId', '==', currentProjectId()).where('agentId', 'in', chunk)
      .where('assigneeProfileId', '==', profileId).where('visibility', 'in', ['private', 'project']).where('status', '==', 'open')),
  ]);
  const millis = (snap?: DocumentSnapshot) => snap?.updateTime?.toMillis() ?? 0;
  return found.map((doc, i) => ({
    ...(covered[i] ?? { id: doc.id, allowed: connectionAllowed(doc.data()!, operators),
      }),
    agent: doc.data()!,
    queued: waitingSets.some(ids => ids.has(doc.id)), needsYou: needsYouIds.has(doc.id),
    ...(pause ? { pause } : {}),
    sourceRevision: Math.max(millis(doc), millis(contacts[i])),
  }));
}

// DTO mapping for request-fresh canonical sources, shared by all list surfaces.
export async function readCanonicalAgentStates(found: DocumentSnapshot<Agent>[], viewer: string | null, now: number,
  statusDocs?: ReadyCanonicalContacts): Promise<CommunicationAgent[]> {
  return toCommunicationAgents(await canonicalStatusSources(found, viewer, undefined, statusDocs), viewer, now);
}
function toCommunicationAgents(sources: AgentStateSources[], profileId: string | null, now: number): CommunicationAgent[] {
  return sources.map((s): CommunicationAgent => {
    const { state, projectPause, reportedAt, lastContactAt, freshUntil } = deriveAgentState(s, now);
    // Same fields, same order as before the derivation was shared.
    return { id: s.id, name: s.agent.name, mine: s.agent.ownerProfileId === profileId, state, ...(projectPause ? { projectPause } : {}),
      personaChoice: profileId ? personaChoice(s.agent.persona?.text ?? '') : null,
      focus: s.agent.focus ? { text: s.agent.focus.text, updatedAt: s.agent.focus.updatedAt } : null,
      reportedAt, lastContactAt, freshUntil };
  });
}
