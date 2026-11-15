import { repositoryWaitMessage } from './repository-readiness';
import type { RepositoryReadiness, StartWait } from '@mlswarm/contracts';
import type { Runtime } from './ui/ComputerSetup';
export const validAgentModel = (model: string) => model.trim() === '' || /^[A-Za-z0-9_:.-]{1,150}$/.test(model.trim());
// The task is optional: the server defaults an absent one to the project's goal.
export const validAgentGoal = (goal: string) => new TextEncoder().encode(goal.trim()).length <= 8000;
export type Provider = 'codex' | 'claude';
export type StartPayload = { id: string; projectId: string; name: string; scope?: string; execution: { provider: Provider; model: string | null }; approved: true };
export type StartRequest = StartPayload & { state: 'pending' | 'accepted' | 'starting' | 'working' | 'failed' | 'expired' | 'recovery_required'; agentId: string | null; code?: string; repository?:RepositoryReadiness|null; waitingFor?: StartWait | null; createdAt: number; pickupByAt: number; launchByAt: number | null; deadlineAt: number | null };
export const terminalStart = (request: StartRequest) => ['working', 'failed', 'expired', 'recovery_required'].includes(request.state);
export const computerOnline = (runtime?: Runtime | null, now = Date.now()) => runtime?.protocol === 1 && runtime.online && now - runtime.lastSeenAt < 45_000;
export const availableProviders = (runtime?: Runtime | null, now = Date.now()): Provider[] => computerOnline(runtime, now)
  ? runtime!.providers.filter(p => p.available && p.reason === 'ready' && (p.id === 'codex' || p.id === 'claude')).map(p => p.id as Provider) : [];
export function startMessage(request: StartRequest): string {
  if (request.state === 'working') return 'Your agent started. Open it to follow along.';
  if (request.state === 'expired') return 'Your agent couldn’t start in time. Nothing is running. Start a new request to try again.';
  if (request.state === 'recovery_required') return 'This needs a look on your computer. Check the agent and MyLittleSwarm before starting more.';
  if (request.state === 'failed' && request.code === 'cancelled') return 'This queued start was stopped. It will not launch.';
  if (request.state === 'failed') return 'Your computer could not start this agent. Check MyLittleSwarm, your coding agent’s sign-in and project access, then try again.';
  if (request.state === 'pending' && request.waitingFor === 'project') return 'Your agent starts when the owner starts the project.';
  if (request.state === 'pending' && request.waitingFor === 'time') return 'Your agent starts when the project has more time.';
  if (request.state === 'pending' && request.waitingFor === 'computer') return 'Your agent starts when your computer is online.';
  if (request.state === 'pending' && request.waitingFor === 'github') return repositoryWaitMessage(request.repository);
  if (request.state === 'pending' && request.waitingFor === 'empty_repository') return 'Your agent starts after the repository’s first commit.';
  return request.state === 'pending' ? 'Starting… Waiting for your computer to accept this request.' : 'Starting… Your computer is getting the agent ready.';
}
export function readSavedStart(raw: string | null, projectId: string): StartPayload | null {
  try {
    const p = JSON.parse(raw ?? 'null');
    return p && /^[0-9a-f-]{36}$/i.test(p.id) && p.projectId === projectId && /^[\w-]{1,64}$/.test(p.name) && (p.scope === undefined || typeof p.scope === 'string' && p.scope.trim() && new TextEncoder().encode(p.scope).length <= 8000) && p.minutes === undefined && p.connectionId === undefined && ['codex', 'claude'].includes(p.execution?.provider) && (p.execution.model === null || (typeof p.execution.model === 'string' && validAgentModel(p.execution.model))) && p.approved === true ? p : null;
  } catch { return null; }
}
