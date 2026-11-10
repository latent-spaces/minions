// Sharing is opt-in. Keep raw model output, prompts, paths and auth material in
// the private report; only these fixed diagnostic/usage fields leave the host.
const tokens = value => value ? Object.fromEntries(['input', 'output', 'cacheRead', 'cacheWrite', 'modelCalls'].map(name => [name, Number.isSafeInteger(value[name]) && value[name] >= 0 ? value[name] : null])) : undefined;
export function nativeSmokeSummary(report) {
  return {
    passed: report.passed, sourceCommit: report.sourceCommit, platform: report.platform,
    architecture: report.architecture, osRelease: report.osRelease, node: report.node,
    startedAt: report.startedAt, finishedAt: report.finishedAt, phase: report.phase,
    syntheticCoordination: true, cleanupFailed: Boolean(report.cleanupErrors?.length),
    providers: Object.fromEntries(Object.entries(report.providers).map(([provider, result]) => [provider, {
      clientVersion: result.clientVersion, selectedModel: result.selectedModel,
      state: result.state, reason: result.reason, queuedDuringTurn: result.queuedDuringTurn,
      initialFile: result.initialFile, steeringFile: result.steeringFile, steering: result.steering,
      stopped: result.stopped ? { state: result.stopped.state, guardPid: result.stopped.guardPid, currentTurnId: result.stopped.currentTurnId } : undefined,
      reopenedOutcomeCount: result.reopenedOutcomeCount,
      outcomes: result.outcomes?.map(({ outcome }) => ({
        failed: outcome.failed, failureCode: outcome.failureCode, delivery: outcome.delivery,
        cleanupConfirmed: outcome.cleanupConfirmed, model: outcome.usage?.model,
        tokens: tokens(outcome.usage?.tokens), phase: outcome.diagnostics?.phase,
        nativeExitCode: outcome.diagnostics?.exit_code, guardExitCode: outcome.diagnostics?.guard_exit_code,
      })),
    }])),
  };
}
