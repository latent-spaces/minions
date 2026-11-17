import type { Transaction } from '../firestore.js';
import type { ProjectWorkersView } from '@minions/contracts';
import { presence, runnerUsage } from '../v2/records.js';

// Caller has already selected agents owned by the current authenticated project
// member. Read only their existing observations; never infer zero from absence.
export async function readWorkerObservation(tx: Transaction, agentId: string): Promise<Pick<ProjectWorkersView['agents'][number], 'usage' | 'lastActivityAt'>> {
  const [contact, report] = await Promise.all([tx.get(presence().doc(agentId)), tx.get(runnerUsage().doc(agentId))]);
  const usage = report.data(), seen = contact.data();
  const last = Math.max(seen?.lastContactAt ?? 0, seen?.activity?.at ?? 0, usage?.lastReportedAt ?? 0);
  return { usage: usage ? { input: usage.input, output: usage.output, lastReportedAt: usage.lastReportedAt, turns: usage.turns,
    tokenReports: usage.tokenReports, inputSemantics: usage.inputSemantics, ...(usage.provider ? { provider: usage.provider } : {}),
    cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, tokenCoverage: usage.tokenCoverage } : null,
    lastActivityAt: last || null };
}
