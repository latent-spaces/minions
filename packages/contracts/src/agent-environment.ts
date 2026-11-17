// Private, descriptive connector observations. Discovery is never proof of native loading.
export type InstructionSource = {
  path: string;
  scope: 'global' | 'managed' | 'ancestor' | 'project' | 'local' | 'rules' | 'nested' | 'runner';
  status: 'discovered' | 'missing' | 'unreadable' | 'supplied';
  sha256: string | null;
};
export type AgentEnvironmentReport = {
  schemaVersion: 1;
  client: 'claude' | 'codex' | 'unknown';
  mode: 'current_chat' | 'background_worker';
  connectorVersion: string;
  capturedAt: number;
  workingFolder: string;
  sources: InstructionSource[];
  truncated: boolean;
  nativeLoading: 'unverified';
};
export type AgentEnvironmentView = {
  agentId: string;
  report: AgentEnvironmentReport | null;
  receivedAt: number | null;
  serverTime: number;
};
