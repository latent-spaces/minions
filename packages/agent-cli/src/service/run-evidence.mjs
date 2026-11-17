// Owner inspection only. Resolve historical paths from the trusted installation
// after the ledger verifies the complete target. Retained logs need no live agent
// credential; caller input can never select a local filename.
import { readRunJournal } from '../run-journal.mjs';
import { inspectWorkerCheckout } from '../checkout-ownership.mjs';
import { diagnoseMissionRecovery } from './recovery-diagnostics.mjs';
import { RuntimeError, sameTarget, validateTarget, validateUuid } from './contracts.mjs';

export function createRunEvidence({ controllers, principal, resolveBinding, resolveJournalDirectory, registryRoot }) {
  if (typeof resolveJournalDirectory !== 'function') throw new Error('A trusted historical journal resolver is required.');
  async function missionFor(input) {
    const target = validateTarget(input.target);
    validateUuid(input.missionId, 'missionId');
    if (target.site !== principal.site || target.ownerId !== principal.ownerId)
      throw new RuntimeError('forbidden', 'This mission is outside the installation owner.');
    const mission = await controllers.getMission({ missionId: input.missionId, target });
    if (!mission || !sameTarget(mission.target, target))
      throw new RuntimeError('not_found', 'The exact mission target was not found.');
    return mission;
  }
  function journalFor(mission, page = {}) {
    return readRunJournal({ directory: resolveJournalDirectory(mission),
      identity: { target: mission.target, missionId: mission.missionId, generation: mission.generation,
        provider: mission.execution.provider, model: mission.execution.model }, ...page });
  }
  return {
    async getRunLog(input) {
      const mission = await missionFor(input);
      return { missionId: mission.missionId, target: mission.target, generation: mission.generation,
        ...journalFor(mission, { after: input.after, limit: input.limit }) };
    },
    async getRecoveryDiagnostics(input) {
      const mission = await missionFor(input), binding = resolveBinding(mission.target);
      const page = await controllers.listReports({ missionId: mission.missionId, target: mission.target, limit: 100 });
      const journal = journalFor(mission, { limit: 1 });
      const checkout = binding ? inspectWorkerCheckout({ folder: binding.folder, agentId: mission.target.agentId,
        project: mission.target.projectId, ...(registryRoot ? { registryRoot } : {}) })
        : { status: 'uncertain', complete: false, exactClaims: [], overlappingOtherClaims: 0,
          invalidRecords: 0, reasons: ['binding_unavailable'] };
      return diagnoseMissionRecovery({ mission, reports: page.reports, reportsComplete: !page.next, checkout, journal });
    },
  };
}
