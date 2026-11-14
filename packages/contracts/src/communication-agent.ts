import type { AgentFocus } from './agent-focus.js';

/** Current member-visible observations, separate from the communication replay. */
/** Talking: between turns, with an agent message sent in the last 90 seconds (owner, 14 November 2026). */
export type CommunicationAgentState = 'working' | 'talking' | 'idle' | 'waiting' | 'needs_you' | 'blocked'
  | 'pausing' | 'pause_unconfirmed' | 'paused' | 'stopped' | 'completed' | 'offline' | 'revoked' | 'unknown';
export type CommunicationAgent = {
  id: string; name: string; mine: boolean; state: CommunicationAgentState;
  /** Current persona category for members; custom instructions are never included. */
  personaChoice?: import('./agent-persona-presets.js').PersonaChoice | null;
  focus: AgentFocus | null; reportedAt: number | null; lastContactAt: number | null;
  /** Positive live observations expire even when the next refresh fails. */
  freshUntil: number | null;
  projectPause?: { revision: number; requestedAt: number; confirmedAt: number | null; externalChat: boolean };
};
export type CommunicationAgents = { agents: CommunicationAgent[]; serverTime: number };
/** Agent actions shown on the Home stage beside agent-to-agent messages: published updates and questions to people. */
export type CommunicationEvent = {
  kind: 'update' | 'question'; id: string; at: number;
  agent: { id: string; name: string | null } | null; authorName: string | null;
  title: string; status: 'open' | 'answered' | 'resolved' | null;
};
export type CommunicationEvents = { at: number; events: CommunicationEvent[]; serverTime: number };
