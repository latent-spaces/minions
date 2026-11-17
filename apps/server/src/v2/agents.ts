import { FieldPath } from '../firestore.js';
import { V2_LIMITS } from '../config.js';
import { Refusal } from '../errors.js';
import { activeRecipientOperators, connectionAllowed } from '../projects/access.js';
import { agents, currentProjectId, db } from '../firestore.js';
import { decodeCursor, encodeCursor } from '../cursor.js';
import { type Phase } from './records.js';
import type { CommunicationAgentState } from '@minions/contracts';
import { canonicalStatusSources, deriveAgentState } from '../view/communication-agents.js';
import { focusWithSource } from '../projects/agent-focus.js';

type AgeBucket = 'lt_90s' | '90s_to_5m' | '5m_to_1h' | 'gte_1h';
type AgentEntry = {
  agentId: string; name: string; operatorName: string; sameOperator: boolean;
  contact: { freshness: 'recent' | 'stale' | 'unknown'; ageBucket: AgeBucket | null };
  currentRunEnded: boolean | null;
  lastReported: { phase: Phase | null; phaseAgeBucket: AgeBucket | null; acceptingWork: boolean | null };
  focus: ReturnType<typeof focusWithSource>;
  state: CommunicationAgentState;
};

// Coarse observations for other agents, never exact contact times or a liveness score.
function ageBucket(at: number | undefined, now: number): AgeBucket | null {
  if (typeof at !== 'number' || !Number.isFinite(at) || at > now) return null;
  const age = (now - at) / 1000;
  if (age < V2_LIMITS.runActiveSeconds) return 'lt_90s';
  if (age < 300) return '90s_to_5m';
  if (age < 3600) return '5m_to_1h';
  return 'gte_1h';
}

// Agents in name order, optionally those whose name starts with namePrefix. A page reads
// findAgentsPage current connections (or limit); removed memberships may leave fewer entries.
export async function findAgents(input: { namePrefix?: string, cursor?: string, limit?: number }, now: () => number, requesterPersonId: string): Promise<{
  agents: AgentEntry[], next: string | null
}> {
  let query = agents().where('revokedAt', '==', null).orderBy('name').orderBy(FieldPath.documentId()).limit(input.limit ?? V2_LIMITS.findAgentsPage);
  const prefix = input.namePrefix?.trim() ?? '';
  const scope = [currentProjectId(), prefix];
  if (prefix) query = query.where('name', '>=', prefix).where('name', '<', `${prefix}`);
  if (input.cursor !== undefined) {
    const after = decodeCursor(input.cursor);
    if (!after || after.length !== 4 || scope.some((part, i) => after[i] !== part)
      || typeof after[2] !== 'string' || !/^[\w-]{1,64}$/.test(after[2])
      || typeof after[3] !== 'string' || !/^[\w-]{1,200}$/.test(after[3])) {
      throw new Refusal('bad_input', 'Use the find_agents cursor returned for this project and name prefix.');
    }
    query = query.startAfter(after[2], after[3]);
  }
  const page = await query.get();
  const active = page.docs;
  const personIds = [...new Set(active.map((d) => d.data().ownerProfileId))];
  const operators = await db.runTransaction(tx => activeRecipientOperators(tx, personIds), { readOnly: true });
  const members = active.filter(d => connectionAllowed(d.data(), operators));
  // The same sources and derivation as the app's map and directory, so MCP and the app agree on each agent's state.
  // An agent's run comes from its status document, read at request time, instead of runs/{agent} (S3; the writer floors are
  // a deploy precondition, not a switch). Its worker group is canonical too; no pointer status source remains.
  const sources = await canonicalStatusSources(members, null, operators);
  const at = now();
  const last = page.docs.at(-1);
  return {
    agents: members.map((d, i) => {
      const agent = d.data();
      const run = sources[i].run;
      const observation = sources[i].contact;
      // A leftover presence row from a previous run must not describe its replacement.
      const seen = run && observation?.runId === run.runId ? observation : undefined;
      // State and contact age come from the same derivation as the map: the newest contact of the current run, from the
      // worker session or presence (c1, c2). lastReported stays the agent's own phase report and its age.
      const derived = deriveAgentState(sources[i], at);
      const contactAge = ageBucket(derived.lastContactAt ?? undefined, at);
      return {
        agentId: d.id, name: agent.name, operatorName: operators.get(agent.ownerProfileId)!.name,
        sameOperator: agent.ownerProfileId === requesterPersonId,
        focus: focusWithSource(d.id, agent.focus),
        contact: { freshness: contactAge === null ? 'unknown' : contactAge === 'lt_90s' ? 'recent' : 'stale', ageBucket: contactAge },
        currentRunEnded: seen && run ? run.endedAt !== null : null,
        lastReported: { phase: seen?.phase ?? null, phaseAgeBucket: ageBucket(seen?.phaseAt, at), acceptingWork: seen?.acceptingWork ?? null },
        // The app's status word for this agent (no exact times: MCP keeps coarse age buckets for other agents).
        state: derived.state,
      };
    }),
    next: page.size === (input.limit ?? V2_LIMITS.findAgentsPage) && last ? encodeCursor([...scope, last.data().name, last.id]) : null,
  };
}
