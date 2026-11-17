import { metricsJob } from '../analytics/projection.js';
import { prepareProjectJourney } from '../onboarding/journeys.js';
import { reportsModelWork } from '../onboarding/progress.js';
// Completion evidence never grants a runner contact, execution or mutation authority.
import { createHash } from 'node:crypto';
import type { Transaction } from '../firestore.js';
import { agents, currentProjectId, db } from '../firestore.js';
import { assertAgentMembership } from '../projects/access.js';
import { Refusal } from '../errors.js';
import { runnerUsage, runHistory, turnReceipts, type LastTurn, type UsageTotals, type TurnUsage } from './records.js';
import { prepareUsageProgress } from './usage-progress.js';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).filter(([,v]) => v !== undefined)
    .sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export const runHistoryId = (agentId: string, runId: string) => digest([agentId, runId]);
export const reportFingerprint = (lastTurn: LastTurn) => digest(lastTurn);
const turnReportId = (agentId: string, runId: string, sequence: number) => digest([agentId, runId, sequence]);

// All reads finish before the caller invokes commit; phase writes use this same accounting.
export async function prepareTurnReceipt(tx: Transaction, agentId: string, runId: string, lastTurn: LastTurn, at: number) {
  const usage = lastTurn.usage;
  if (!usage) throw new Refusal('bad_input', 'Completion reports require usage.sequence.');
  const reportId = turnReportId(agentId, runId, usage.sequence);
  const historyRef = runHistory().doc(runHistoryId(agentId, runId));
  const receiptRef = turnReceipts().doc(reportId);
  const [historyDoc, receiptDoc, totalsDoc] = await Promise.all([tx.get(historyRef), tx.get(receiptRef), tx.get(runnerUsage().doc(agentId))]);
  const totals = totalsDoc.data();
  // Every run is recorded when it starts; a report for a run that never started is refused.
  const history = historyDoc.data();
  if (!history) throw new Refusal('run_superseded', 'No issued run history exists for this completion report.');
  if (history.agentId !== agentId || history.runId !== runId) throw new Refusal('forbidden', 'This run belongs to another agent.');
  const fingerprint = reportFingerprint(lastTurn), existing = receiptDoc.data();
  if (existing && existing.fingerprint !== fingerprint) throw new Refusal('runtime_conflict', 'This completion report identity already has different evidence. Keep the local report for review.');
  const usageProgress = !existing ? await prepareUsageProgress(tx, [agentId]) : null;
  return { reportId, duplicate: Boolean(existing), commit: () => {
    if (!existing) {
      tx.create(receiptRef, { agentId, runId, sequence: usage.sequence, fingerprint, lastTurn, receivedAt: at });
      const job = metricsJob(receiptRef.path, at);
      tx.create(job.ref, job.data);
      const next = addUsage(totals, runId, usage, at);
      tx.set(runnerUsage().doc(agentId), next);
      usageProgress!(agentId, 'usage');
    }
  } };
}

export async function reportTurn(agentId: string, runId: string, lastTurn: LastTurn, now: () => number) {
  return db.runTransaction(async tx => {
    // Current membership and connection epoch remain authoritative even for historical evidence.
    await assertAgentMembership(tx, agentId);
    const receipt = await prepareTurnReceipt(tx, agentId, runId, lastTurn, now());
    const progress = reportsModelWork(lastTurn) ? await prepareProjectJourney(tx, (await tx.get(agents().doc(agentId))).data()!.ownerProfileId, currentProjectId(), now()) : null;
    progress?.(['firstWork']);
    receipt.commit();
    return { ok: true as const, report_id: receipt.reportId, duplicate: receipt.duplicate };
  });
}
function addUsage(totals: UsageTotals | undefined, runId: string, usage: TurnUsage, at: number): UsageTotals {
  const tokens = usage.tokens;
  const coverage = (key: 'input' | 'output' | 'cacheRead' | 'cacheWrite') =>
    (totals?.tokenCoverage[key] ?? 0) + (tokens?.[key] != null ? 1 : 0);
  return {
    runId, sequence: usage.sequence, firstReportedAt: totals?.firstReportedAt ?? at, lastReportedAt: at,
    turns: (totals?.turns ?? 0) + 1, seconds: (totals?.seconds ?? 0) + usage.seconds,
    model: usage.model, provider: usage.provider ?? 'unknown', modelSource: usage.modelSource ?? 'unknown',
    inputSemantics: !totals?.turns ? usage.inputSemantics ?? 'unknown'
      : (totals.inputSemantics ?? 'unknown') === (usage.inputSemantics ?? 'unknown') ? totals.inputSemantics ?? 'unknown' : 'mixed',
    tokenCoverage: { input: coverage('input'), output: coverage('output'), cacheRead: coverage('cacheRead'), cacheWrite: coverage('cacheWrite') },
    toolCalls: (totals?.toolCalls ?? 0) + (usage.toolCalls ?? 0),
    toolReports: (totals?.toolReports ?? 0) + (usage.toolCalls !== undefined ? 1 : 0),
    partialToolReports: (totals?.partialToolReports ?? 0) + (usage.toolCalls !== undefined && usage.toolScope !== 'provider-stream' ? 1 : 0),
    costUsd: (totals?.costUsd ?? 0) + (usage.costUsd ?? 0),
    costReports: (totals?.costReports ?? 0) + (usage.costUsd != null ? 1 : 0),
    tokenReports: (totals?.tokenReports ?? 0) + (tokens !== null ? 1 : 0),
    input: (totals?.input ?? 0) + (tokens?.input ?? 0),
    output: (totals?.output ?? 0) + (tokens?.output ?? 0),
    cacheRead: (totals?.cacheRead ?? 0) + (tokens?.cacheRead ?? 0),
    cacheWrite: (totals?.cacheWrite ?? 0) + (tokens?.cacheWrite ?? 0),
    modelCalls: (totals?.modelCalls ?? 0) + (tokens?.modelCalls ?? 0),
  };
}
