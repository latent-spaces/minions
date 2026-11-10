// Only the coordination service is synthetic. This local-only port lets the
// opt-in smoke exercise real clients/models without production project writes.
export function nativeSmokeCoordination(principal, now = Date.now) {
  const messages = new Map();
  return {
    accountClient: {
      async submitSteering(projectId, input) {
        const previous = messages.get(input.operationId);
        if (previous && JSON.stringify(previous.input) !== JSON.stringify({ projectId, ...input })) throw new Error('Smoke steering retry changed its immutable input.');
        const record = previous ?? { input: { projectId, ...input }, message: { ...input, actorProfileId: principal.ownerId, createdAt: now(), state: 'queued' } };
        messages.set(input.operationId, record);
        return { created: !previous, message: record.message };
      },
      async steeringResult(projectId, id) { const value = messages.get(id); return { message: value?.input.projectId === projectId ? value.message : null }; },
    },
    async cloudFactory(mission) {
      return {
        async start() { return { runId: mission.missionId, cloudGeneration: 1 }; },
        async observe() { return { project: { started: true, paused: false, closed: false }, pending: 0, acknowledged: 0 }; },
        async workerSession() { return { missionId: mission.missionId, messages: [...messages.values()].filter(({ input }) => input.projectId === mission.target.projectId && input.agentId === mission.target.agentId && input.missionId === mission.missionId && input.generation === mission.generation).map(({ message }) => ({ id: message.operationId, missionId: message.missionId, generation: message.generation, body: message.body })) }; },
        async phase() {}, async reportStatus() {},
      };
    },
  };
}
