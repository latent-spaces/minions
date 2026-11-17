import { inspectWorkerCheckout, releaseOrphanedCheckout } from '../checkout-ownership.mjs';
import { missionMark, stopMarkedProcesses } from '../leftover-processes.mjs';
import { readLinuxProcessBaseline } from '../linux-process-baseline.mjs';
import { stopWindowsMission } from '../windows-supervision.mjs';

// Explicit owner Stop of a mission no controller holds, typically after the
// connector crashed or restarted. Ends every process that carries this exact
// mission's identity, then frees its checkout. Throws, changing nothing more,
// when another running connector still owns the checkout or the end of the
// processes cannot be confirmed; the same Stop can then be retried.
export async function stopOrphanedMission(mission, { folder, registryRoot, stateDir, platform = process.platform,
  stopMarked = stopMarkedProcesses, stopWindows = stopWindowsMission } = {}) {
  const worker = { folder, agentId: mission.target.agentId, project: mission.target.projectId, ...(registryRoot ? { registryRoot } : {}) };
  const checkout = inspectWorkerCheckout(worker);
  if (!['observed', 'missing'].includes(checkout.status) || checkout.complete !== true || checkout.invalidRecords !== 0)
    throw new Error('Worker checkout ownership cannot be inspected; no process was stopped.');
  if (checkout.exactClaims.some(claim => claim.owner !== 'absent'))
    throw new Error('Another running connector still owns this worker; no process was stopped.');
  const mark = missionMark(mission);
  const { stopped = 0 } = platform === 'win32' ? await stopWindows(mark) : await stopMarked(mark, { ...(platform === 'linux' && stateDir ? { baseline: readLinuxProcessBaseline(stateDir, mark) } : {}) });
  const { released } = checkout.status === 'missing' ? { released: 0 } : await releaseOrphanedCheckout(worker);
  return { stopped, released };
}
