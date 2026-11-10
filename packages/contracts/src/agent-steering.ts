// Safe repository observations contain no raw Git output, credentials or local paths.
export type RepositoryReadiness = {waitingFor:'github'|'empty_repository'|null;code:string;checkedAt:number};
// What a queued start waits for. A job has no time limit, so a start never waits for time.
export type StartWait = 'project' | 'computer' | 'github' | 'empty_repository';
export type WorkerSteeringSession = {
  missionId: string; runId: string; generation: number; startedAt: number;
  phase: 'waiting' | 'working' | 'paused' | 'blocked' | 'stopped' | 'completed';
  lastContactAt: number; remainingSlots: number;
  /** Exact project Pause confirmed only after native execution has settled. */
  projectPauseRevision?: number;
  // Tokens this mission counted toward the cap (input + cache writes + output, cache reads excluded), as the
  // computer last reported them. unknownTurns: finished turns whose provider reported no usage; they are not counted.
  tokens?: WorkerTokens;
  // The job's token cap as the last reply told this worker; null when the job has no cap. The cap is one pool for
  // all the person's agents in the project: othersUsed is the tokens the pool counted outside this mission (the
  // person's other missions in this job, ended, restarted and revoked agents included).
  tokenLimit?: WorkerTokenLimit | null;
  // The model provider refused the last turn for a usage or rate limit, and the worker waits to try again. retryAt is
  // the provider's reset time when it named one; null when it did not (the worker then waits a growing time, up to 15
  // minutes). Absent when no limit is holding the worker.
  providerLimit?: { retryAt: number | null };
};
export type WorkerTokens = { counted: number; unknownTurns: number };
export type WorkerTokenLimit = { tokens: number; othersUsed: number };
export type SteeringView = { agentId: string; session: WorkerSteeringSession | null;
  available: boolean; serverTime: number };

export type ProjectWorkersView = { agents: { agentId: string; agentName: string; worker: SteeringView;
  projectPause?: import('./communication-agent.js').CommunicationAgent['projectPause'];
  usage?: (import('./reported-usage.js').ReportedUsage & { lastReportedAt: number; tokenReports: number; provider?: string }) | null;
  personaChoice?: import('./agent-persona-presets.js').PersonaChoice;
  focus?: import('./agent-focus.js').AgentFocus | null;
  lastActivityAt?: number | null;
  backgroundControl?: import('./background-controls.js').BackgroundControlView | null;
  participation?: import('./chat-controls.js').ParticipationControlView | null;
  // The agent's latest queued run, and the computer it runs on, for Play and the Waiting status.
  // A failed, expired or working start is 'superseded' once a newer mission has started for the agent, and a working
  // start whose own run has ended is 'ended', so this field never contradicts worker.session or lastRun.
  run?: { id: string; state: string; waitingFor: StartWait | null; connectionId: string; execution: { provider: 'codex' | 'claude'; model: string | null }; repository?:RepositoryReadiness|null } | null;
  // Chosen in the coding agent; shown read-only on the website.
  settings: { involvement: 'with_me' | 'on_own' };
  // The agent's current run as stored: endedAt and endReason say how it last ended.
  lastRun: { startedAt: number | null; endedAt: number | null; endReason: string | null } | null }[];
  // New agents added from the website that no computer has registered yet.
  queued: { id: string; name: string; waitingFor: StartWait | null }[];
  // A closed project offers no Play/Pause or other agent controls.
  projectClosed?: boolean; serverTime: number };

// Observation only: no steering messages, credentials, computer IDs or control authority.
// Shared hosted agent rows use this shape and the same status resolver.
export type AgentObservation = {
  agentId: string; agentName: string;
  projectPause?: import('./communication-agent.js').CommunicationAgent['projectPause'];
  focus?: import('./agent-focus.js').AgentFocus | null;
  worker: { session: Pick<WorkerSteeringSession, 'missionId' | 'generation' | 'phase' | 'lastContactAt' | 'tokens' | 'tokenLimit' | 'providerLimit'> | null };
  backgroundControl?: Pick<import('./background-controls.js').BackgroundControlView, 'missionId' | 'state' | 'deviceLastSeenAt'> | null;
  run?: { state: string; waitingFor: StartWait | null; repository?:RepositoryReadiness|null } | null;
};
