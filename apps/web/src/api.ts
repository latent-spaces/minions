import { createContext } from 'react';
import { ApiError, authorizedRequest as request } from './authorized-request';
// The service's read-only viewer endpoints (apps/server/src/view/routes.ts). Sign-in goes through `session`.
import type { SessionClient, SessionUser } from './session-identity';
import { siteSession } from './site-session';

/** This page's sign-in: the MyLittleSwarm engine's own sessions (src/server-session.ts). */
export const session: SessionClient = siteSession;
export const signIn = (options?: { chooseAccount?: boolean }) => session.signIn(options);
export const signOutNow = () => session.signOut();

export type Overview = {
  repositorySummary?: import('@mlswarm/contracts').RepositorySummary | null;
  project: { name: string, mission: string, rules: string, repoUrl: string, startsAt: number, started: boolean, paused: boolean, pauseRequest?: { revision: number; requestedAt: number }, completedAt?: number | null, awaitingKickoff?: boolean } | null;
  agentCount: number;
  messageCount: number | null;
  generatedAt: number;
  serverTime: number;
};


export type AgentRow = {
  personaChoice?: import('@mlswarm/contracts').PersonaChoice | null;
  id: string;
  name: string;
  operatorPhoto?: import('./profile-photo-api').PublicPhoto | null;
  operatorName: string | null;
  operatorId: string | null;
  createdAt: number;
  revokedAt: number | null;
  focus?: import('@mlswarm/contracts').AgentFocus | null;
  v2Contact: { lastContactAt: number, phase: string, phaseAt: number } | null;
  activity: { tool: string; at: number } | null;
  usage: { firstReportedAt: number; lastReportedAt: number; turns: number; seconds: number;
    model: string | null; input: number; output: number; cacheRead: number; cacheWrite: number;
    modelCalls: number; costUsd: number; costReports: number; tokenReports: number;
    tokenCoverage: { input: number; output: number; cacheRead: number; cacheWrite: number };
    provider?: string; modelSource?: string; inputSemantics?: string;
    toolCalls?: number; toolReports?: number; partialToolReports?: number } | null;
  // The agent's status, computed once on the server for every screen; freshUntil is when a live status goes stale.
  state: import('@mlswarm/contracts').CommunicationAgentState;
  freshUntil: number | null;
};

// A native task assigned to this person's agent, independent of the agent's runtime state.
export type OwnedTask = Pick<import('@mlswarm/contracts').NativeTask, 'id' | 'title' | 'status' | 'revision' | 'updatedAt'>;

type Named = { id: string, name: string | null };
export type Audience =
  | { kind: 'direct', to: Named[] }
  | { kind: 'project' };

export type MessageRow = { id: string, threadId: string, body: string, summary?: string | null, createdAt: number, steering?: {state: 'queued'|'received'|'included'|'uncertain'|'ended';origin:'coding_chat'|'local_app';observedAt:number|null;deliveries?:{agentId:string;agentName:string|null;state:'queued'|'received'|'included'|'uncertain'|'ended';observedAt:number|null}[]}; sender: Named & {kind?:'person'|'agent'; photo?: import('./profile-photo-api').PublicPhoto | null; operatorId?: string | null; operatorName?: string | null; operatorPhoto?: import('./profile-photo-api').PublicPhoto | null }, audience: Audience };
// A conversation is listed with its first message (null if it cannot be read) and its latest one.
export type ConversationRow = { threadId: string, count: number, first: MessageRow | null, latest: MessageRow };

export { ApiError } from './authorized-request';

export async function publicProfile(id: string): Promise<import('./community-api').PublicProfileData> {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw new ApiError(404, 'This profile is unavailable.');
  const res = await fetch(`/api/profiles/${id}`);
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.message ?? 'This profile could not be loaded.');
  if (data?.id !== id) throw new Error('The profile did not match the selected person.');
  return data;
}

const authorizedRequest = <T,>(user: SessionUser, base: string, path: string, body?: object, ownProfileId?: string) => request<T>(user, base, path, body, ownProfileId, () => session.currentUid());
// The open project's ID. Project pages render only inside the provider App sets, so there is no default project.
export const ProjectScope = createContext('');
export const projectBase = (id: string) => `/p/${id}`;
export const read = <T>(user: SessionUser | null, path: string, projectId: string) => user
  ? authorizedRequest<T>(user, `${projectBase(projectId)}/api/view`, path)
  : publicProject<T>(projectId, path);

// Anonymous catalog/Card reads. Private sections never use this reader.
export async function discover<T>(path = ''): Promise<T> {
  if (!/^(?:\?[^#]*|\/[a-f0-9]{64})?$/.test(path)) throw new Error('Choose a published project or search.');
  const res = await fetch(`/api/discovery/projects${path}`);
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.message ?? 'Projects could not be loaded. Try again.');
  return data as T;
}
export async function publicProject<T>(id: string, path = '', body?: object): Promise<T> {
  if (!/^[a-f0-9]{64}$/.test(id) || body !== undefined || !/^(?:\/(?:agents(?:\/[\w-]{1,200})?|conversations(?:\/search)?|messages\/[\w-]{1,200}|threads\/[\w-]{1,200}(?:\/search)?|issues))?(?:\?[^#]*)?$/.test(path)) throw new Error('Choose a public, read-only project page.');
  const user = session.currentUser();
  if (!user) throw new ApiError(401, 'Sign in with your invited account.');
  return authorizedRequest<T>(user, `/api/projects/public/${id}`, path);
}
export const join = <T>(user: SessionUser, path: string, body: object | undefined, projectId: string) => authorizedRequest<T>(user, `${projectBase(projectId)}/api/join`, path, body);
export const projects = <T>(user: SessionUser, path: string, body?: object) => authorizedRequest<T>(user, '/api/projects', path, body);
export const privateProjects = <T>(user: SessionUser, ownProfileId: string, path: string, body?: object) => authorizedRequest<T>(user, '/api/projects', path, body, ownProfileId);
export const community = <T>(user: SessionUser, path: string, body?: object) => authorizedRequest<T>(user, '/community', path, body);

export const platform = <T>(user: SessionUser, path: string, body?: object) => authorizedRequest<T>(user, '/api/platform', path, body);

export const owner = <T>(user: SessionUser, path: string, body?: object, ownProfileId?: string) => authorizedRequest<T>(user, '/api/owner', path, body, ownProfileId);
export const ownOwner = <T>(user: SessionUser, profileId: string, path: string, body?: object) => authorizedRequest<T>(user, '/api/owner', path, body, profileId);

export const needsYou = <T>(user: SessionUser, profileId: string, path: string, body?: object) => authorizedRequest<T>(user, '/api/needs-you', path, body, profileId);
