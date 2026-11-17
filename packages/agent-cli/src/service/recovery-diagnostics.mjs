import { sameTarget } from './contracts.mjs';

// A read-only explanation of authoritative observations. It deliberately has no
// filesystem/process mutation, report replay or scheduler capability.
export function diagnoseMissionRecovery({ mission, reports = [], reportsComplete = true, checkout, journal }) {
  const flags = [], recommendations = [];
  const flag = (code, recommendation) => { if (!flags.includes(code)) flags.push(code); if (recommendation && !recommendations.includes(recommendation)) recommendations.push(recommendation); };
  if (!mission?.target || typeof mission.missionId !== 'string' || !Number.isSafeInteger(mission.generation)) throw new Error('An authoritative exact mission is required for recovery inspection.');
  const counts = { pending: 0, delivered: 0, attention: 0, archived: 0, unknown: 0 };
  const selected = reports.filter(report => report.missionId === mission.missionId && report.generation === mission.generation && sameTarget(report.target, mission.target));
  for (const report of selected) counts[Object.hasOwn(counts, report.state) ? report.state : 'unknown']++;
  if (reportsComplete !== true) flag('report_page_incomplete', 'Read subsequent report pages before concluding delivery is complete.');
  if (counts.pending) flag('report_delivery_pending', 'Keep undelivered report evidence; the normal delivery worker may retry eligible reports.');
  if (counts.attention) flag('report_attention', 'Inspect the exact report and cloud receipt. With explicit owner approval, recover_agent_run retry_report can requeue unchanged attention evidence.');
  if (counts.archived) flag('archived_is_not_delivered');
  if (counts.unknown) flag('report_state_unknown');
  const claims = checkout?.exactClaims ?? [];
  if (!checkout || checkout.status === 'uncertain' || checkout.complete !== true) flag('checkout_inspection_incomplete', 'Inspect private ownership records without removing them or starting replacement work.');
  if (checkout?.overlappingOtherClaims) flag('overlapping_other_checkout_owner', 'Preserve the overlapping owner; use a separate checkout or stop work through its owning session.');
  if (claims.some(claim => claim.cleanup !== 'idle_recorded')) flag('checkout_cleanup_unconfirmed', 'Recorded process absence does not prove descendant cleanup. Preserve the claim until trusted whole-process-group cleanup is confirmed.');
  if (claims.some(claim => claim.owner === 'absent' && claim.cleanup !== 'idle_recorded')) flag('checkout_owner_absent');
  const outcomes = Array.isArray(mission.outcomes) ? mission.outcomes : [];
  const last = outcomes.at(-1);
  const cleanupConfirmed = last?.outcome?.cleanupConfirmed;
  const savedEvidence = last?.outcome?.evidence;
  const savedEvidenceFaults = Array.isArray(savedEvidence?.faults) ? savedEvidence.faults.length : 0;
  if (savedEvidence?.availability === 'unavailable' || savedEvidenceFaults) flag('saved_outcome_evidence_fault', 'The ledger recorded a journal capture fault; a readable journal prefix does not prove the full attempt was captured.');
  if (savedEvidence?.truncated === true) flag('saved_outcome_evidence_truncated');
  if (mission.state === 'recovery_required' || cleanupConfirmed === false) flag('mission_recovery_required', 'Inspect this exact attempt and retain its reports. Owner-approved recover_agent_run finalize requires settled execution and a complete trusted checkout inspection; it never resumes side effects.');
  if (mission.currentTurnId) flag('turn_unsettled', 'A recorded turn remains unsettled; journal events are observations and cannot replace a durable outcome.');
  const availability = journal?.availability ?? 'unavailable';
  const journalFaults = Array.isArray(journal?.faults) ? journal.faults.length : 0;
  const interruptedAttempts = Array.isArray(journal?.interruptedAttempts) ? journal.interruptedAttempts.length : Number.isSafeInteger(journal?.interruptedAttempts) ? journal.interruptedAttempts : 0;
  if (availability === 'unavailable') flag('run_evidence_unavailable', 'Historical or missing journal evidence is unavailable, not proof of an empty successful run.');
  else if (availability !== 'available' || journalFaults) flag('run_evidence_uncertain', 'Preserve damaged or partial evidence and inspect it before drawing conclusions.');
  if (journal?.truncated || journal?.partialTail) flag('run_evidence_incomplete');
  if (journal?.hasMore) flag('journal_page_incomplete', 'Read subsequent journal pages for more captured evidence; pagination alone does not mean capture was lost.');
  if (interruptedAttempts) flag('attempt_evidence_unsettled', 'An attempt lacks terminal journal evidence; use the ledger and cleanup proof to establish its actual outcome.');
  return {
    version: 1, readOnly: true, automaticRecoverySupported: false,
    mission: { target: { site: mission.target.site, ownerId: mission.target.ownerId, projectId: mission.target.projectId, agentId: mission.target.agentId },
      missionId: mission.missionId, generation: mission.generation, state: mission.state,
      currentTurnId: mission.currentTurnId ?? null, savedOutcomeCount: outcomes.length,
      lastOutcome: last ? { sequence: last.sequence, turnId: last.turnId, createdAt: last.createdAt,
        delivery: last.outcome?.delivery ?? 'unknown', cleanupConfirmed: typeof cleanupConfirmed === 'boolean' ? cleanupConfirmed : null,
        failed: last.outcome?.failed === true, interrupted: last.outcome?.interrupted === true,
        evidence: savedEvidence ? { availability: savedEvidence.availability, truncated: savedEvidence.truncated === true, faultCount: savedEvidenceFaults } : null } : null },
    reports: { counts, complete: reportsComplete === true, observed: selected.length },
    checkout: checkout ?? { status: 'unavailable', complete: false },
    journal: { availability, truncated: journal?.truncated === true,
      partialTail: journal?.partialTail === true, hasMore: journal?.hasMore === true, faultCount: journalFaults, interruptedAttempts },
    flags, recommendations,
    limitations: ['Read-only observations grant no permission to kill processes, remove claims, archive/replay reports or restart work.',
      'Missing recorded process IDs do not prove whole-process-group cleanup.', 'Journal text and HTTP acknowledgements do not prove cloud delivery or human/model consumption.'],
  };
}
