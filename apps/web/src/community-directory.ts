import type { PublicPhoto } from './profile-photo-api';
import type { CommunicationAgentState } from '@minions/contracts';
import { COMMUNICATION_AGENT_LABELS, communicationAgentState } from './ui/communication-agent-state';
// The Community tab's directory (owner request, 19 October 2026): everyone in the project, people and agents,
// built only from the members and agents pages the project page already loads.

export type DirectoryMember = { id: string; name: string | null; photo?: PublicPhoto | null; character?: import('@minions/contracts').PersonCharacter | null };
export type DirectoryAgent = { id: string; name: string; operatorId: string | null; operatorName: string | null; operatorPhoto?: PublicPhoto | null; revokedAt: number | null;
  usage?: { provider?: string } | null;
  state: CommunicationAgentState; freshUntil: number | null;
  personaChoice?: import('@minions/contracts').PersonaChoice | null;
  focus?: import('@minions/contracts').AgentFocus | null;
  task?: import('./api').AgentRow['task'] };
export type DirectoryKind = 'all' | 'people' | 'agents';
export type DirectoryEntry =
  | { kind: 'person'; id: string; name: string; photo?: PublicPhoto | null; character?: import('@minions/contracts').PersonCharacter | null; owner: boolean; agents: number }
  | { kind: 'agent'; state: CommunicationAgentState; provider?: string; id: string; name: string; ownerId: string | null; ownerName: string | null; operatorPhoto?: PublicPhoto | null; status: string; personaChoice?: import('@minions/contracts').PersonaChoice | null };

/** The members page lists the owner first on its first page (the service puts the owner there), so `ownerFirst`
 *  marks that entry as the owner; other roles are not in the members data and are left out. */
export function directoryEntries(members: DirectoryMember[], agents: DirectoryAgent[], now: number, ownerFirst = true): DirectoryEntry[] {
  const people: DirectoryEntry[] = members.map((m, index) => ({ kind: 'person', id: m.id, name: m.name ?? 'Removed person', photo: m.photo, character: m.character, owner: ownerFirst && index === 0,
    agents: agents.filter(a => a.operatorId === m.id && a.revokedAt === null).length }));
  const bots: DirectoryEntry[] = agents.map(a => ({ kind: 'agent', state: communicationAgentState(a, now), provider: a.usage?.provider, id: a.id, name: a.name, ownerId: a.operatorId, ownerName: a.operatorName, operatorPhoto: a.operatorPhoto,
    personaChoice: a.personaChoice, status: COMMUNICATION_AGENT_LABELS[communicationAgentState(a, now)] }));
  return [...people, ...bots];
}

/** Keeps one kind and the entries whose name (or, for agents, owner's name) contains the search, ignoring case. */
export function filterDirectory(entries: DirectoryEntry[], kind: DirectoryKind, search: string): DirectoryEntry[] {
  const q = search.trim().toLocaleLowerCase();
  return entries.filter(entry => (kind === 'all' || (kind === 'people') === (entry.kind === 'person'))
    && (!q || entry.name.toLocaleLowerCase().includes(q) || entry.kind === 'agent' && !!entry.ownerName?.toLocaleLowerCase().includes(q)));
}

export function directoryCounts(entries: DirectoryEntry[]) {
  const people = entries.filter(e => e.kind === 'person').length;
  return { all: entries.length, people, agents: entries.length - people };
}
