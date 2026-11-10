// Trusted native-binding adapter. None of these composition functions are MCP tools.
export function createWorkerBridgeFactory({ getService, workerOperations }) {
  if (typeof getService !== 'function' || !workerOperations) throw new TypeError('A service resolver and project operations are required.');
  const caller = mission => ({ kind: 'worker', target: mission.target, missionId: mission.missionId, generation: mission.generation });
  return {
    async createBridge(mission) {
      const scope = caller(mission), endpoint = await getService().issueWorker(scope);
      let revoked;
      return { ...endpoint,
        beginContext: () => workerOperations.beginContext(scope),
        endContext: () => workerOperations.endContext(scope),
        deliveryState: () => workerOperations.deliveryState(scope),
        retryPending: options => workerOperations.retryPending(scope, options),
        acknowledgeNotices: notices => workerOperations.acknowledgeNotices(scope, notices),
        revoke() { return revoked ??= (async () => { try { await endpoint.revoke(); } finally { await workerOperations.release(scope); } })(); },
      };
    },
    prepareParticipation({ mission, signal, pauseUpdate }) { return workerOperations.prepareParticipation(caller(mission), { signal, pauseUpdate }); },
  };
}
