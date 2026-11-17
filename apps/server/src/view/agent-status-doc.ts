import type { Agent } from '../firestore.js';
import type { Phase, Presence, Run } from '../v2/records.js';
import type { WorkerSummary } from '../projects/worker-sessions.js';
import type { AgentStateSources } from './communication-agents.js';

// Current-state contract C3 (CS2a, c5's part): the shape of the status document presence/{agentId}, and the one pure
// mapping from it back to the derivation's sources. The read side (c2's CS2b) derives state with deriveAgentState on
// these sources, so a projection answers exactly what the map and MCP answer from the source documents (C1).
// Writers own disjoint groups and blind-merge only their own (c4's guard). Inputs are stored, never derived state.
export type AgentStatusDoc = {
  // run group (top level, as presence today), plus the run's end and mode, written by the run's start and every
  // run-ending writer in the same transaction (c1's list: reportPhase stopping, chat stop,
  // member cleanup, account cleanup, onboarding, close-work).
  runId: string | null; lastContactAt: number; phase: Phase; phaseAt: number;
  lastTurn?: Presence['lastTurn']; activity?: Presence['activity']; acceptingWork?: boolean | null; protocol?: 2;
  runEndedAt?: number | null; runMode?: 'current_chat' | null;
  // agent group, from the agents/{id} writers, including creation. connectionEpoch is needed for "revoked" (with the
  // owner's current membership epoch, read from the project's memberships, not from this document).
  agent?: { name: string; ownerProfileId: string; revokedAt: number | null; connectionEpoch: number;
    focus: { text: string; updatedAt: number } | null; personaText: string; lastSendAt?: number | null };
  // Every accepted worker sync replaces this group whole, including the worker's own contact. Status readers
  // use only this canonical group; the mission pointer remains solely for action authority.
  worker?: { runId: string; phase: WorkerSummary['phase']; lastContactAt: number; deadlineAt: number; projectPauseRevision?: number | null };
};

// Project-level inputs the document cannot hold: the owners' membership epochs (for revocation), the project pause and
// whether a pending or accepted web start names the agent (queued, from today's open-starts query: card v15 S4 removed
// the start group, which no reader used and which could never cover starts with no agent or from before its writers).
// Viewer fields (Needs you) are layered per request, never stored.
export type StatusContext = {
  allowed: (agent: Pick<Agent, 'ownerProfileId' | 'connectionEpoch'>) => boolean;
  queued?: boolean;
  pause?: { revision: number; requestedAt: number };
  needsYou?: boolean;
};

// An explicit null/null creation marker proves never-run. A pre-A1 group-only record can still have a legacy run.
// Canonical shared and request-time readers use this rule. Historical records need no migration.
export function statusRunComplete(doc: { agent?: unknown; runId?: string | null; runEndedAt?: number | null } | undefined): boolean {
  if (doc?.agent == null) return false;
  if (doc.runId === null) return doc.runEndedAt === null;
  // Firestore data can violate its TypeScript annotation. A present but malformed end must not bypass the
  // counted source reader and become a fabricated active/ended run in the covered mapper.
  return typeof doc.runId === 'string' && doc.runId.length > 0 && (doc.runEndedAt === null
    || typeof doc.runEndedAt === 'number' && Number.isFinite(doc.runEndedAt) && doc.runEndedAt >= 0);
}

// Sources for deriveAgentState, or null when the agent/run groups need migration.
export function sourcesFromStatusDoc(id: string, doc: AgentStatusDoc | undefined, ctx: StatusContext, revision = 0): AgentStateSources | null {
  if (!statusRunComplete(doc)) return null;
  const a = doc!.agent!;
  const agent = { name: a.name, ownerProfileId: a.ownerProfileId, revokedAt: a.revokedAt, connectionEpoch: a.connectionEpoch,
    focus: a.focus, persona: { text: a.personaText ?? '' }, recentSends: a.lastSendAt == null ? [] : [a.lastSendAt] } as unknown as Agent;
  const status = doc!;
  const run = !status.runId ? undefined
    : { runId: status.runId, endedAt: status.runEndedAt ?? null, ...(status.runMode ? { mode: status.runMode } : {}) } as Run;
  const contact = !status.runId ? undefined
    : { runId: status.runId, lastContactAt: status.lastContactAt, phase: status.phase, phaseAt: status.phaseAt, acceptingWork: status.acceptingWork } as Presence;
  const worker = status.worker && run ? { runId: status.worker.runId, phase: status.worker.phase, deadlineAt: status.worker.deadlineAt,
    projectPauseRevision: status.worker.projectPauseRevision, lastContactAt: status.worker.lastContactAt } as WorkerSummary : undefined;
  return { id, agent, allowed: ctx.allowed(a), run, contact, worker, queued: ctx.queued === true,
    needsYou: ctx.needsYou === true, ...(ctx.pause ? { pause: ctx.pause } : {}), sourceRevision: revision };
}

// What the contract's writers together store for an agent whose sources are `s` (the model used by the conformance
// test; the real writers are c4's). The run group's contact is the newest stored contact of the run, from presence or
// the worker sync.
export function statusDocFromSources(s: AgentStateSources): AgentStatusDoc {
  const sameRunContact = s.contact && s.run && s.contact.runId === s.run.runId ? s.contact : undefined;
  const sameRunWorker = s.worker && s.run && s.worker.runId === s.run.runId ? s.worker : undefined;
  const contacts = [sameRunContact?.lastContactAt, sameRunWorker?.lastContactAt].filter((at): at is number => typeof at === 'number');
  return {
    ...(s.run ? { runId: s.run.runId, lastContactAt: contacts.length ? Math.max(...contacts) : 0, phase: sameRunContact?.phase ?? 'idle',
      phaseAt: sameRunContact?.phaseAt ?? 0, runEndedAt: s.run.endedAt ?? null, runMode: s.run.mode ?? null } : { runId: null, runEndedAt: null }),
    agent: { name: s.agent.name, ownerProfileId: s.agent.ownerProfileId, revokedAt: s.agent.revokedAt, connectionEpoch: s.agent.connectionEpoch,
      focus: s.agent.focus ? { text: s.agent.focus.text, updatedAt: s.agent.focus.updatedAt } : null, personaText: s.agent.persona?.text ?? '',
      lastSendAt: s.agent.recentSends?.length ? Math.max(...s.agent.recentSends) : null },
    ...(s.worker ? { worker: { runId: s.worker.runId, phase: s.worker.phase, deadlineAt: s.worker.deadlineAt,
      projectPauseRevision: s.worker.projectPauseRevision, lastContactAt: s.worker.lastContactAt } } : {}),
  } as AgentStatusDoc;
}
